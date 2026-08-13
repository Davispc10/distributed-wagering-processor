import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertWalletConsistency, closeOrm, getOrm, truncateAll } from '@test/support/database';
import { postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';
import {
  TEST_QUEUES,
  approximateCount,
  drainQueue,
  sendRaw,
  sendWagerMessage,
  waitFor,
} from '@test/support/sqs';

/**
 * Integração do consumidor SQS com Postgres e MiniStack REAIS.
 *
 * Nada de mock: o que está sendo testado é justamente o comportamento que
 * mocks não reproduzem — inbox resolvendo corrida no banco, redelivery do
 * broker, redrive para a DLQ.
 */

let orm: MikroORM;
let api: AppInstance;
let worker: AppInstance;

const uniqueSuffix = (): string =>
  `${String(Date.now())}-${String(Math.floor(performance.now() * 1000) % 100000)}`;

async function createWallet(balance = '1000.00'): Promise<{ walletId: string; playerId: string }> {
  const playerId = crypto.randomUUID();
  const res = await postJson(`${api.baseUrl}/wallets`, {
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  if (res.body.id === undefined)
    throw new Error(`falha ao criar wallet: ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

async function transactionByKey(key: string): Promise<{ status: string; kind: string } | null> {
  const rows = await orm.em
    .getConnection()
    .execute<{ status: string; kind: string }[]>(
      `SELECT status, kind FROM wager_transactions WHERE idempotency_key = ?`,
      [key],
    );
  return rows[0] ?? null;
}

async function ledgerCount(walletId: string): Promise<number> {
  const rows = await orm.em
    .getConnection()
    .execute<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
  return Number(rows[0]?.count ?? '0');
}

async function walletBalance(walletId: string): Promise<string> {
  const rows = await orm.em
    .getConnection()
    .execute<{ balance_amount: string }[]>(
      `SELECT balance_amount::text FROM wallets WHERE id = ?`,
      [walletId],
    );
  return rows[0]?.balance_amount ?? 'n/a';
}

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);
  await drainQueue(TEST_QUEUES.main);
  await drainQueue(TEST_QUEUES.dlq);
  await drainQueue(TEST_QUEUES.events);

  api = await startInstance('src/main-api.ts', { name: 'itest-api', port: 4301 });
  worker = await startInstance('src/main-worker.ts', { name: 'itest-worker', port: 4401 });
});

afterAll(async () => {
  await stopAll([api, worker]);
  await closeOrm();
});

beforeEach(async () => {
  await drainQueue(TEST_QUEUES.dlq);
});

describe('consumidor SQS', () => {
  it('processa uma BET vinda da fila usando o mesmo use case do HTTP', async () => {
    const { walletId, playerId } = await createWallet('500.00');
    const suffix = uniqueSuffix();
    const key = `provider-a:sqs-${suffix}`;

    await sendWagerMessage({
      messageId: `msg-${suffix}`,
      providerId: 'provider-a',
      externalTransactionId: `sqs-${suffix}`,
      idempotencyKey: key,
      playerId,
      walletId,
      roundId: 'round-sqs',
      gameId: 'fortune-chimp',
      kind: 'BET',
      amount: '30.00',
    });

    const tx = await waitFor(
      async () => {
        const found = await transactionByKey(key);
        return found?.status === 'PROCESSED' ? found : null;
      },
      { description: 'BET vinda do SQS ser processada' },
    );

    expect(tx.kind).toBe('BET');
    expect(await walletBalance(walletId)).toBe('470.00');
    expect(await ledgerCount(walletId)).toBe(2); // OPENING + BET
    await assertWalletConsistency(orm, walletId);
  }, 60_000);

  it('a mesma messageId reentregue NÃO duplica o efeito — dedup pelo inbox', async () => {
    const { walletId, playerId } = await createWallet('500.00');
    const suffix = uniqueSuffix();
    const messageId = `msg-dup-${suffix}`;
    const key = `provider-a:dup-${suffix}`;

    const payload = {
      messageId,
      providerId: 'provider-a',
      externalTransactionId: `dup-${suffix}`,
      idempotencyKey: key,
      playerId,
      walletId,
      roundId: 'round-dup',
      gameId: 'g',
      kind: 'BET',
      amount: '40.00',
    };

    await sendWagerMessage(payload);
    await waitFor(
      async () => ((await transactionByKey(key))?.status === 'PROCESSED' ? true : null),
      { description: 'primeira entrega processar' },
    );

    const balanceAfterFirst = await walletBalance(walletId);
    const entriesAfterFirst = await ledgerCount(walletId);

    // Reenvia a MESMA messageId. `dedupSuffix` burla a deduplicação do broker
    // de propósito: queremos provar que o INBOX segura, não o SQS.
    for (let i = 0; i < 3; i++) {
      await sendWagerMessage(payload, { dedupSuffix: `-redelivery-${String(i)}` });
    }

    // Espera o consumidor drenar a fila.
    await waitFor(async () => ((await approximateCount(TEST_QUEUES.main)) === 0 ? true : null), {
      description: 'fila esvaziar após as reentregas',
      timeoutMs: 40_000,
    });

    expect(await walletBalance(walletId)).toBe(balanceAfterFirst);
    expect(await ledgerCount(walletId)).toBe(entriesAfterFirst);
    await assertWalletConsistency(orm, walletId);
  }, 90_000);

  it('rejeição por regra de negócio é commitada, auditável e recebe ack', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const suffix = uniqueSuffix();
    const key = `provider-a:nofunds-${suffix}`;

    await sendWagerMessage({
      messageId: `msg-nofunds-${suffix}`,
      providerId: 'provider-a',
      externalTransactionId: `nofunds-${suffix}`,
      idempotencyKey: key,
      playerId,
      walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      amount: '9999.00',
    });

    const rows = await waitFor(
      async () => {
        const found = await orm.em
          .getConnection()
          .execute<{ status: string; failure_code: string }[]>(
            `SELECT status, failure_code FROM wager_transactions WHERE idempotency_key = ?`,
            [key],
          );
        return found[0]?.status === 'REJECTED' ? found[0] : null;
      },
      { description: 'transação sem saldo ser rejeitada' },
    );

    expect(rows.failure_code).toBe('INSUFFICIENT_FUNDS');
    // REJECTED não gera lançamento: só o OPENING existe.
    expect(await ledgerCount(walletId)).toBe(1);
    expect(await walletBalance(walletId)).toBe('10.00');

    // Ack: a mensagem não fica voltando para a fila.
    await waitFor(async () => ((await approximateCount(TEST_QUEUES.main)) === 0 ? true : null), {
      description: 'mensagem rejeitada receber ack',
    });
    await assertWalletConsistency(orm, walletId);
  }, 60_000);

  it('payload malformado vai para a DLQ sem consumir as 5 tentativas', async () => {
    await sendRaw(JSON.stringify({ isso: 'não é uma mensagem válida' }), 'malformed');

    const count = await waitFor(
      async () => {
        const n = await approximateCount(TEST_QUEUES.dlq);
        return n > 0 ? n : null;
      },
      { description: 'mensagem malformada chegar na DLQ', timeoutMs: 40_000 },
    );

    expect(count).toBeGreaterThan(0);
  }, 60_000);
});

describe('transactional outbox', () => {
  it('grava o evento na mesma transação e o worker publica depois', async () => {
    const { walletId, playerId } = await createWallet('300.00');
    const suffix = uniqueSuffix();

    await postJson(
      `${api.baseUrl}/wagering/transactions`,
      {
        providerId: 'provider-a',
        externalTransactionId: `outbox-${suffix}`,
        playerId,
        walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      },
      { 'Idempotency-Key': `provider-a:outbox-${suffix}` },
    );

    // O publisher roda no worker e marca published_at só APÓS publicar no SQS.
    const published = await waitFor(
      async () => {
        const rows = await orm.em.getConnection().execute<{ count: string }[]>(
          `SELECT COUNT(*)::text AS count FROM outbox_messages
            WHERE payload->'data'->>'walletId' = ? AND published_at IS NOT NULL`,
          [walletId],
        );
        return Number(rows[0]?.count ?? '0') > 0 ? Number(rows[0]?.count) : null;
      },
      { description: 'evento ser publicado pelo outbox worker', timeoutMs: 40_000 },
    );

    expect(published).toBeGreaterThan(0);

    // Nenhum evento fica pendente indefinidamente.
    await waitFor(
      async () => {
        const rows = await orm.em
          .getConnection()
          .execute<{ count: string }[]>(
            `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
          );
        return Number(rows[0]?.count ?? '0') === 0 ? true : null;
      },
      { description: 'outbox drenar completamente', timeoutMs: 40_000 },
    );

    await assertWalletConsistency(orm, walletId);
  }, 90_000);

  it('WalletBalanceChanged só é publicado quando o saldo muda', async () => {
    const { walletId, playerId } = await createWallet('200.00');
    const suffix = uniqueSuffix();

    // LOSS: registra o desfecho, não move saldo.
    await postJson(
      `${api.baseUrl}/wagering/transactions`,
      {
        providerId: 'provider-a',
        externalTransactionId: `loss-${suffix}`,
        playerId,
        walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'LOSS',
        money: { amount: '15.00', currency: 'BRL' },
      },
      { 'Idempotency-Key': `provider-a:loss-${suffix}` },
    );

    const events = await orm.em.getConnection().execute<{ event_type: string }[]>(
      `SELECT event_type FROM outbox_messages
        WHERE payload->'data'->>'externalTransactionId' = ?`,
      [`loss-${suffix}`],
    );

    const types = events.map((e) => e.event_type);
    expect(types).toContain('WagerTransactionProcessed');
    expect(types).not.toContain('WalletBalanceChanged');
    await assertWalletConsistency(orm, walletId);
  }, 60_000);
});
