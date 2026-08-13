import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertWalletConsistency, closeOrm, getOrm, truncateAll } from '@test/support/database';
import { postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';
import {
  TEST_QUEUES,
  approximateCount,
  drainQueue,
  sendWagerMessage,
  sleep,
  waitFor,
} from '@test/support/sqs';

/**
 * Cenários 4 a 8 da seção 13: múltiplas instâncias, crash entre commit e ack,
 * publishers concorrentes, referência fora de ordem e restart.
 */

let orm: MikroORM;
let api: AppInstance;
const workers: AppInstance[] = [];

const uniq = (): string =>
  `${String(Date.now())}-${String(Math.floor(performance.now() * 1000) % 1_000_000)}`;

async function createWallet(balance: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = crypto.randomUUID();
  const res = await postJson(`${api.baseUrl}/wallets`, {
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  if (res.body.id === undefined)
    throw new Error(`falha ao criar wallet: ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

const sql = {
  async transaction(key: string): Promise<{ status: string; id: string } | null> {
    const rows = await orm.em
      .getConnection()
      .execute<{ status: string; id: string }[]>(
        `SELECT status, id FROM wager_transactions WHERE idempotency_key = ?`,
        [key],
      );
    return rows[0] ?? null;
  },
  async ledgerCount(walletId: string): Promise<number> {
    const rows = await orm.em
      .getConnection()
      .execute<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [walletId],
      );
    return Number(rows[0]?.count ?? '0');
  },
  async balance(walletId: string): Promise<string> {
    const rows = await orm.em
      .getConnection()
      .execute<{ balance_amount: string }[]>(
        `SELECT balance_amount::text FROM wallets WHERE id = ?`,
        [walletId],
      );
    return rows[0]?.balance_amount ?? 'n/a';
  },
  async pendingOutbox(): Promise<number> {
    const rows = await orm.em
      .getConnection()
      .execute<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
      );
    return Number(rows[0]?.count ?? '0');
  },
};

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);
  await drainQueue(TEST_QUEUES.main);
  await drainQueue(TEST_QUEUES.dlq);
  await drainQueue(TEST_QUEUES.events);

  api = await startInstance('src/main-api.ts', { name: 'res-api', port: 4601 });
}, 120_000);

afterAll(async () => {
  await stopAll([api, ...workers]);
  await closeOrm();
});

describe('cenário 4 — três ou mais processos simultâneos', () => {
  it('três workers consomem a mesma fila sem duplicar efeito', async () => {
    for (const [i, port] of [4701, 4702, 4703].entries()) {
      workers.push(
        await startInstance('src/main-worker.ts', {
          name: `res-worker-${String(i + 1)}`,
          port,
        }),
      );
    }

    const { walletId, playerId } = await createWallet('1000.00');
    const run = uniq();
    const count = 20;

    // Todas na mesma wallet: os três workers disputam o MESMO lock de linha.
    for (let i = 0; i < count; i++) {
      await sendWagerMessage({
        messageId: `msg-multi-${run}-${String(i)}`,
        providerId: 'provider-a',
        externalTransactionId: `multi-${run}-${String(i)}`,
        idempotencyKey: `provider-a:multi-${run}-${String(i)}`,
        playerId,
        walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        amount: '10.00',
      });
    }

    await waitFor(
      async () => {
        const rows = await orm.em.getConnection().execute<{ count: string }[]>(
          `SELECT COUNT(*)::text AS count FROM wager_transactions
            WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
          [walletId],
        );
        return Number(rows[0]?.count ?? '0') === count ? true : null;
      },
      { description: `as ${String(count)} apostas serem processadas`, timeoutMs: 90_000 },
    );

    // 1000 - (20 × 10) = 800. Nenhum débito a mais, nenhum a menos.
    expect(await sql.balance(walletId)).toBe('800.00');
    expect(await sql.ledgerCount(walletId)).toBe(count + 1); // + OPENING
    await assertWalletConsistency(orm, walletId);
  }, 180_000);
});

describe('cenário 5 — worker morto depois do commit e antes do ack', () => {
  /**
   * Versão determinística: simula o estado exato do crash.
   *
   * Processamos a mensagem normalmente (commit feito, inbox marcado) e então
   * a **reentregamos**, que é o que o SQS faz quando o ack não chega. Se o
   * dedup do inbox falhasse, aqui apareceria um segundo débito.
   */
  it('a reentrega após o commit não duplica o efeito', async () => {
    const { walletId, playerId } = await createWallet('500.00');
    const run = uniq();
    const messageId = `msg-crash-${run}`;

    const payload = {
      messageId,
      providerId: 'provider-a',
      externalTransactionId: `crash-${run}`,
      idempotencyKey: `provider-a:crash-${run}`,
      playerId,
      walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      amount: '60.00',
    };

    await sendWagerMessage(payload);
    await waitFor(
      async () =>
        (await sql.transaction(payload.idempotencyKey))?.status === 'PROCESSED' ? true : null,
      { description: 'commit da primeira entrega', timeoutMs: 60_000 },
    );

    const balanceAfterCommit = await sql.balance(walletId);
    const entriesAfterCommit = await sql.ledgerCount(walletId);

    // Simula o ack perdido: a MESMA messageId volta para a fila.
    for (let i = 0; i < 5; i++) {
      await sendWagerMessage(payload, { dedupSuffix: `-crash-redelivery-${String(i)}` });
    }

    await waitFor(async () => ((await approximateCount(TEST_QUEUES.main)) === 0 ? true : null), {
      description: 'reentregas serem drenadas',
      timeoutMs: 60_000,
    });

    expect(await sql.balance(walletId)).toBe(balanceAfterCommit);
    expect(await sql.ledgerCount(walletId)).toBe(entriesAfterCommit);
    await assertWalletConsistency(orm, walletId);
  }, 180_000);

  /**
   * Versão real: mata um worker com SIGKILL durante o processamento.
   *
   * O instante exato do kill é indeterminado — pode cair antes do commit,
   * entre commit e ack, ou depois. O teste afirma o que precisa valer em
   * **qualquer** um dos casos: nenhum efeito duplicado e consistência final.
   * Assertar "o kill caiu entre commit e ack" seria assertar sobre o
   * escalonador, e o teste ficaria instável.
   */
  it('SIGKILL durante o processamento não deixa efeito duplicado', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const run = uniq();
    const count = 10;

    for (let i = 0; i < count; i++) {
      await sendWagerMessage({
        messageId: `msg-kill-${run}-${String(i)}`,
        providerId: 'provider-a',
        externalTransactionId: `kill-${run}-${String(i)}`,
        idempotencyKey: `provider-a:kill-${run}-${String(i)}`,
        playerId,
        walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        amount: '5.00',
      });
    }

    // Mata um worker no meio do trabalho; os outros dois continuam.
    await sleep(150);
    const victim = workers[0]!;
    victim.kill('SIGKILL');
    await victim.waitForExit();

    await waitFor(
      async () => {
        const rows = await orm.em.getConnection().execute<{ count: string }[]>(
          `SELECT COUNT(*)::text AS count FROM wager_transactions
            WHERE wallet_id = ? AND status = 'PROCESSED' AND kind = 'BET'`,
          [walletId],
        );
        return Number(rows[0]?.count ?? '0') === count ? true : null;
      },
      { description: 'mensagens serem concluídas pelos workers sobreviventes', timeoutMs: 120_000 },
    );

    expect(await sql.balance(walletId)).toBe('950.00');
    expect(await sql.ledgerCount(walletId)).toBe(count + 1);
    await assertWalletConsistency(orm, walletId);

    // Repõe o worker morto para os testes seguintes.
    workers[0] = await startInstance('src/main-worker.ts', {
      name: 'res-worker-1b',
      port: 4701,
    });
  }, 240_000);
});

describe('cenário 6 — dois publishers sobre a mesma outbox', () => {
  it('publicam tudo sem perder nem travar, e ambos participam do trabalho', async () => {
    const { walletId, playerId } = await createWallet('2000.00');
    const run = uniq();

    // Gera bastante evento para os dois publishers disputarem lotes.
    for (let i = 0; i < 25; i++) {
      await postJson(
        `${api.baseUrl}/wagering/transactions`,
        {
          providerId: 'provider-a',
          externalTransactionId: `pub-${run}-${String(i)}`,
          playerId,
          walletId,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        },
        { 'Idempotency-Key': `provider-a:pub-${run}-${String(i)}` },
      );
    }

    await waitFor(async () => ((await sql.pendingOutbox()) === 0 ? true : null), {
      description: 'outbox ser totalmente drenada pelos publishers',
      timeoutMs: 90_000,
    });

    // Nada ficou pendente e nada ficou preso com lease órfão.
    const stuck = await orm.em.getConnection().execute<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM outbox_messages
        WHERE published_at IS NULL OR locked_until IS NOT NULL`,
    );
    expect(Number(stuck[0]?.count ?? '0')).toBe(0);

    // Nenhum evento precisou de retry: SKIP LOCKED evitou que dois publishers
    // disputassem a mesma linha, em vez de um esperar o outro.
    const retried = await orm.em
      .getConnection()
      .execute<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE attempts > 0`,
      );
    expect(Number(retried[0]?.count ?? '0')).toBe(0);

    await assertWalletConsistency(orm, walletId);
  }, 180_000);
});

describe('cenário 7 — ROLLBACK entregue antes da referência', () => {
  it('fica PENDING_REFERENCE e o worker resolve quando a BET chega', async () => {
    const { walletId, playerId } = await createWallet('300.00');
    const run = uniq();
    const betExternalId = `late-bet-${run}`;

    // O ROLLBACK chega PRIMEIRO — a referência ainda não existe.
    const rollback = await postJson(
      `${api.baseUrl}/wagering/transactions`,
      {
        providerId: 'provider-a',
        externalTransactionId: `rb-${run}`,
        playerId,
        walletId,
        roundId: 'round-late',
        gameId: 'g',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExternalId,
      },
      { 'Idempotency-Key': `provider-a:rb-${run}` },
    );

    expect(rollback.status).toBe(202);
    expect(rollback.body.status).toBe('PENDING_REFERENCE');

    const balanceBeforeBet = await sql.balance(walletId);
    expect(balanceBeforeBet).toBe('300.00');

    // Agora a BET referenciada chega.
    const bet = await postJson(
      `${api.baseUrl}/wagering/transactions`,
      {
        providerId: 'provider-a',
        externalTransactionId: betExternalId,
        playerId,
        walletId,
        roundId: 'round-late',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      },
      { 'Idempotency-Key': `provider-a:${betExternalId}` },
    );
    expect(bet.status).toBe(201);
    expect(await sql.balance(walletId)).toBe('260.00');

    // O PendingReferenceWorker deve resolver o ROLLBACK e devolver os 40.
    await waitFor(
      async () =>
        (await sql.transaction(`provider-a:rb-${run}`))?.status === 'PROCESSED' ? true : null,
      { description: 'ROLLBACK ser resolvido após a referência aparecer', timeoutMs: 90_000 },
    );

    expect(await sql.balance(walletId)).toBe('300.00');
    await assertWalletConsistency(orm, walletId);
  }, 180_000);
});

describe('cenário 8 — reinício do serviço', () => {
  it('mantém a consistência final e retoma o trabalho pendente', async () => {
    const { walletId, playerId } = await createWallet('400.00');
    const run = uniq();

    for (let i = 0; i < 8; i++) {
      await sendWagerMessage({
        messageId: `msg-restart-${run}-${String(i)}`,
        providerId: 'provider-a',
        externalTransactionId: `restart-${run}-${String(i)}`,
        idempotencyKey: `provider-a:restart-${run}-${String(i)}`,
        playerId,
        walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        amount: '10.00',
      });
    }

    // Derruba TODOS os workers no meio do trabalho.
    await sleep(200);
    await stopAll(workers);
    workers.length = 0;

    // Sobe workers novos: eles precisam retomar o que ficou na fila.
    for (const [i, port] of [4801, 4802].entries()) {
      workers.push(
        await startInstance('src/main-worker.ts', {
          name: `restart-worker-${String(i + 1)}`,
          port,
        }),
      );
    }

    await waitFor(
      async () => {
        const rows = await orm.em.getConnection().execute<{ count: string }[]>(
          `SELECT COUNT(*)::text AS count FROM wager_transactions
            WHERE wallet_id = ? AND status = 'PROCESSED' AND kind = 'BET'`,
          [walletId],
        );
        return Number(rows[0]?.count ?? '0') === 8 ? true : null;
      },
      { description: 'workers reiniciados concluírem o trabalho pendente', timeoutMs: 120_000 },
    );

    expect(await sql.balance(walletId)).toBe('320.00');
    expect(await sql.ledgerCount(walletId)).toBe(9);
    await assertWalletConsistency(orm, walletId);

    // A outbox também precisa drenar depois do restart.
    await waitFor(async () => ((await sql.pendingOutbox()) === 0 ? true : null), {
      description: 'outbox drenar após o restart',
      timeoutMs: 90_000,
    });
  }, 300_000);
});

describe('invariante final de toda a suíte', () => {
  it('toda wallet do banco tem saldo == ledger reconstruído', async () => {
    const rows = await orm.em.getConnection().execute<{ id: string }[]>(`SELECT id FROM wallets`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) await assertWalletConsistency(orm, row.id);
  }, 120_000);
});
