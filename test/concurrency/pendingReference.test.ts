import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertWalletConsistency, closeOrm, getOrm, truncateAll } from '@test/support/database';
import { getJson, postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';

/**
 * `claimDuePendingReferences` não é um lease — o `FOR UPDATE SKIP LOCKED` morre
 * junto com a transação do claim. Com N workers, a MESMA linha é reivindicada
 * por todos, e quem serializa é o lock da wallet.
 *
 * Regressão: com a releitura da transação acontecendo ANTES do lock, os dois
 * workers liam PENDING_REFERENCE, o vencedor processava e o perdedor gravava
 * REJECTED por cima — deixando uma transação REJECTED COM lançamento no ledger,
 * o que viola a regra 7.6 e faz o provedor achar que o dinheiro não voltou.
 */

let orm: MikroORM;
let api: AppInstance;
let workers: AppInstance[] = [];

const uniq = (): string =>
  `${String(Date.now())}-${String(Math.floor(performance.now() * 1000) % 1_000_000)}`;

interface Wallet {
  walletId: string;
  playerId: string;
}

async function createWallet(balance: string): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const res = await postJson(`${api.baseUrl}/wallets`, {
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  if (res.body.id === undefined)
    throw new Error(`falha ao criar wallet: ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

async function submit(
  wallet: Wallet,
  externalId: string,
  kind: string,
  roundId: string,
  amount: string,
  reference?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await postJson(
    `${api.baseUrl}/wagering/transactions`,
    {
      providerId: 'provider-a',
      externalTransactionId: externalId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId,
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference !== undefined ? { referenceExternalTransactionId: reference } : {}),
    },
    { 'Idempotency-Key': `provider-a:${externalId}` },
  );
  return { status: res.status, body: res.body as unknown as Record<string, unknown> };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForTerminal(transactionId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'PENDING_REFERENCE';

  while (Date.now() < deadline) {
    const res = await getJson(`${api.baseUrl}/wagering/transactions/${transactionId}`);
    status = String((res.body as unknown as Record<string, unknown>)['status']);
    if (status !== 'PENDING_REFERENCE') return status;
    await sleep(500);
  }
  return status;
}

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const rows = await orm.em.getConnection().execute<{ count: string }[]>(sql, params);
  return Number(rows[0]?.count ?? '0');
};

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);

  api = await startInstance('src/main-api.ts', { name: 'pref-api', port: 4851 });
  // TRÊS workers na mesma tabela: com um só, a corrida não existe.
  workers = await Promise.all([
    startInstance('src/main-worker.ts', { name: 'pref-w1', port: 4852 }),
    startInstance('src/main-worker.ts', { name: 'pref-w2', port: 4853 }),
    startInstance('src/main-worker.ts', { name: 'pref-w3', port: 4854 }),
  ]);
}, 180_000);

afterAll(async () => {
  await stopAll([api, ...workers]);
  await closeOrm();
});

describe('PENDING_REFERENCE com múltiplos workers', () => {
  it('a reversão fora de ordem é resolvida UMA vez, sem REJECTED por cima do PROCESSED', async () => {
    const wallet = await createWallet('1000.00');
    const round = `round-${uniq()}`;
    const betId = `bet-${uniq()}`;
    const rollbackId = `rb-${uniq()}`;

    // O ROLLBACK chega ANTES da BET que ele reverte.
    const rollback = await submit(wallet, rollbackId, 'ROLLBACK', round, '70.00', betId);
    expect(rollback.status).toBe(202);
    expect(rollback.body['status']).toBe('PENDING_REFERENCE');
    const rollbackTxId = rollback.body['transactionId'] as string;

    // Agora a referência aparece: os 3 workers vão disputar a mesma linha.
    const bet = await submit(wallet, betId, 'BET', round, '70.00');
    expect(bet.status).toBe(201);
    expect(await getBalance(wallet.walletId)).toBe('930.00');

    const status = await waitForTerminal(rollbackTxId, 90_000);

    expect(status).toBe('PROCESSED');

    // Um único lançamento para a reversão — e ele pertence a uma PROCESSED.
    expect(
      await count(
        `SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE transaction_id = ?`,
        [rollbackTxId],
      ),
    ).toBe(1);

    // A invariante que o bug quebrava: nenhuma REJECTED pode ter ledger.
    expect(
      await count(
        `SELECT COUNT(*)::text AS count
           FROM wallet_ledger_entries l
           JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE t.status = 'REJECTED'`,
      ),
    ).toBe(0);

    expect(await getBalance(wallet.walletId)).toBe('1000.00');
    await assertWalletConsistency(orm, wallet.walletId);
  }, 180_000);

  it('várias reversões fora de ordem em paralelo não se atropelam', async () => {
    const wallet = await createWallet('1000.00');
    const pending: { txId: string; betId: string; round: string }[] = [];

    // 5 ROLLBACKs órfãos de uma vez.
    for (let i = 0; i < 5; i += 1) {
      const round = `round-multi-${uniq()}-${String(i)}`;
      const betId = `bet-multi-${uniq()}-${String(i)}`;
      const res = await submit(
        wallet,
        `rb-multi-${uniq()}-${String(i)}`,
        'ROLLBACK',
        round,
        '10.00',
        betId,
      );
      expect(res.status).toBe(202);
      pending.push({ txId: res.body['transactionId'] as string, betId, round });
    }

    // As referências chegam todas juntas.
    await Promise.all(
      pending.map(({ betId, round }) => submit(wallet, betId, 'BET', round, '10.00')),
    );

    const statuses = await Promise.all(pending.map(({ txId }) => waitForTerminal(txId, 90_000)));
    expect(statuses).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED', 'PROCESSED']);

    // 5 débitos de 10 e 5 créditos de 10: o saldo volta ao início.
    expect(await getBalance(wallet.walletId)).toBe('1000.00');
    expect(
      await count(
        `SELECT COUNT(*)::text AS count
           FROM wallet_ledger_entries l
           JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE t.status = 'REJECTED'`,
      ),
    ).toBe(0);
    await assertWalletConsistency(orm, wallet.walletId);
  }, 180_000);
});

async function getBalance(walletId: string): Promise<string> {
  const rows = await orm.em
    .getConnection()
    .execute<{ balance: string }[]>(
      `SELECT balance_amount::text AS balance FROM wallets WHERE id = ?`,
      [walletId],
    );
  return rows[0]?.balance ?? '';
}
