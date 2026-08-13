import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertWalletConsistency, closeOrm, getOrm, truncateAll } from '@test/support/database';
import { getJson, postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';

/**
 * Atomicidade entre wallet, ledger, transação e outbox, e paginação por cursor.
 */

let orm: MikroORM;
let api: AppInstance;

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

async function bet(
  walletId: string,
  playerId: string,
  externalId: string,
  amount: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await postJson(
    `${api.baseUrl}/wagering/transactions`,
    {
      providerId: 'provider-a',
      externalTransactionId: externalId,
      playerId,
      walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
    { 'Idempotency-Key': `provider-a:${externalId}` },
  );
  return { status: res.status, body: res.body as unknown as Record<string, unknown> };
}

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const rows = await orm.em.getConnection().execute<{ count: string }[]>(sql, params);
  return Number(rows[0]?.count ?? '0');
};

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);
  // Só a API: sem worker, a outbox não é drenada e podemos inspecionar o que
  // a transação financeira gravou nela.
  api = await startInstance('src/main-api.ts', { name: 'atom-api', port: 4901 });
}, 120_000);

afterAll(async () => {
  await stopAll([api]);
  await closeOrm();
});

describe('atomicidade da transação financeira', () => {
  it('wallet, ledger, transação e outbox são gravados juntos', async () => {
    const { walletId, playerId } = await createWallet('500.00');
    const externalId = `atom-${uniq()}`;

    const res = await bet(walletId, playerId, externalId, '75.00');
    expect(res.status).toBe(201);

    const transactionId = res.body['transactionId'] as string;

    expect(
      await count(`SELECT COUNT(*)::text AS count FROM wager_transactions WHERE id = ?`, [
        transactionId,
      ]),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE transaction_id = ?`,
        [transactionId],
      ),
    ).toBe(1);
    // Um WagerTransactionProcessed + um WalletBalanceChanged.
    expect(
      await count(
        `SELECT COUNT(*)::text AS count FROM outbox_messages
          WHERE payload->'data'->>'transactionId' = ?`,
        [transactionId],
      ),
    ).toBe(2);

    await assertWalletConsistency(orm, walletId);
  }, 60_000);

  it('rejeição não deixa lançamento nem evento de saldo, mas registra a transação', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const externalId = `reject-${uniq()}`;

    const res = await bet(walletId, playerId, externalId, '9999.00');
    expect(res.status).toBe(422);

    const transactionId = res.body['transactionId'] as string;

    // A transação REJECTED É persistida — auditável (seção 7.6).
    expect(
      await count(
        `SELECT COUNT(*)::text AS count FROM wager_transactions WHERE id = ? AND status = 'REJECTED'`,
        [transactionId],
      ),
    ).toBe(1);
    // Sem lançamento.
    expect(
      await count(
        `SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE transaction_id = ?`,
        [transactionId],
      ),
    ).toBe(0);
    // Um WagerTransactionRejected, e NENHUM WalletBalanceChanged.
    expect(
      await count(
        `SELECT COUNT(*)::text AS count FROM outbox_messages
          WHERE payload->'data'->>'transactionId' = ? AND event_type = 'WalletBalanceChanged'`,
        [transactionId],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*)::text AS count FROM outbox_messages
          WHERE payload->'data'->>'transactionId' = ? AND event_type = 'WagerTransactionRejected'`,
        [transactionId],
      ),
    ).toBe(1);

    await assertWalletConsistency(orm, walletId);
  }, 60_000);

  it('nenhum evento é publicado antes do commit — sem worker, nada sai da outbox', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    await bet(walletId, playerId, `nopub-${uniq()}`, '10.00');

    // Sem OutboxPublisherWorker rodando, published_at continua nulo: os eventos
    // existem apenas como linha de tabela dentro da transação já commitada.
    const pending = await count(
      `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(pending).toBeGreaterThan(0);

    const published = await count(
      `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NOT NULL`,
    );
    expect(published).toBe(0);
  }, 60_000);

  it('a abertura da wallet gera OPENING + ledger na mesma transação', async () => {
    const { walletId } = await createWallet('250.00');

    const opening = await orm.em
      .getConnection()
      .execute<{ id: string; status: string }[]>(
        `SELECT id, status FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'`,
        [walletId],
      );
    expect(opening.length).toBe(1);
    expect(opening[0]?.status).toBe('PROCESSED');

    const entries = await orm.em
      .getConnection()
      .execute<{ direction: string; balance_before: string; balance_after: string }[]>(
        `SELECT direction, balance_before::text, balance_after::text
         FROM wallet_ledger_entries WHERE transaction_id = ?`,
        [opening[0]!.id],
      );
    expect(entries.length).toBe(1);
    expect(entries[0]?.direction).toBe('CREDIT');
    expect(entries[0]?.balance_before).toBe('0.00');
    expect(entries[0]?.balance_after).toBe('250.00');

    await assertWalletConsistency(orm, walletId);
  }, 60_000);
});

describe('paginação do ledger por cursor', () => {
  it('percorre todas as páginas sem repetir nem pular lançamentos', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const run = uniq();

    for (let i = 0; i < 12; i++) {
      await bet(walletId, playerId, `page-${run}-${String(i)}`, '1.00');
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const url = new URL(`${api.baseUrl}/wallets/${walletId}/ledger`);
      url.searchParams.set('limit', '5');
      if (cursor !== undefined) url.searchParams.set('cursor', cursor);

      const res = await getJson(url.toString());
      const body = res.body as unknown as {
        entries: { id: string }[];
        nextCursor?: string;
      };

      seen.push(...body.entries.map((e) => e.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 20);

    // 12 apostas + 1 OPENING.
    expect(seen.length).toBe(13);
    expect(new Set(seen).size).toBe(13);
    expect(pages).toBe(3);
  }, 120_000);

  it('rejeita cursor inválido com 400', async () => {
    const { walletId } = await createWallet('10.00');
    const res = await getJson(
      `${api.baseUrl}/wallets/${walletId}/ledger?cursor=nao-eh-um-cursor-valido`,
    );
    expect(res.status).toBe(400);
  }, 60_000);
});

describe('consultas de transação', () => {
  it('busca por id interno e por (providerId, externalTransactionId)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalId = `lookup-${uniq()}`;

    const created = await bet(walletId, playerId, externalId, '5.00');
    const transactionId = created.body['transactionId'] as string;

    const byId = await getJson(`${api.baseUrl}/wagering/transactions/${transactionId}`);
    expect(byId.status).toBe(200);

    const byExternal = await getJson(
      `${api.baseUrl}/providers/provider-a/wagering/transactions/${externalId}`,
    );
    expect(byExternal.status).toBe(200);
    expect((byExternal.body as unknown as { transactionId: string }).transactionId).toBe(
      transactionId,
    );
  }, 60_000);
});
