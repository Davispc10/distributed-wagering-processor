import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  assertWalletConsistency,
  closeOrm,
  getOrm,
  truncateAll,
  uuid,
} from '@test/support/database';
import { postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';

/**
 * Diferencial: ledger de partidas dobradas.
 *
 * Aditivo — `wallet_ledger_entries` continua sendo a fonte da verdade do saldo.
 * O journal acrescenta a contrapartida, e a soma zero é garantida por trigger
 * DEFERRABLE no banco.
 */

let orm: MikroORM;
let api: AppInstance;

const uniqSuffix = (): string =>
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

async function submit(
  walletId: string,
  playerId: string,
  externalId: string,
  kind: string,
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
      kind,
      money: { amount, currency: 'BRL' },
    },
    { 'Idempotency-Key': `provider-a:${externalId}` },
  );
  return { status: res.status, body: res.body as unknown as Record<string, unknown> };
}

async function journalOf(
  transactionId: string,
): Promise<{ account_code: string; direction: string; amount: string }[]> {
  return orm.em
    .getConnection()
    .execute<{ account_code: string; direction: string; amount: string }[]>(
      `SELECT l.account_code, l.direction, l.amount::text
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE e.transaction_id = ?
      ORDER BY l.account_code`,
      [transactionId],
    );
}

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);
  await orm.em.getConnection().execute(`TRUNCATE journal_lines, journal_entries CASCADE`);
  api = await startInstance('src/main-api.ts', { name: 'de-api', port: 4951 });
}, 120_000);

afterAll(async () => {
  await stopAll([api]);
  await closeOrm();
});

describe('partidas dobradas', () => {
  it('a abertura credita o passivo do jogador contra os depósitos', async () => {
    const { walletId } = await createWallet('500.00');

    const opening = await orm.em
      .getConnection()
      .execute<{ id: string }[]>(
        `SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'`,
        [walletId],
      );

    const lines = await journalOf(opening[0]!.id);
    expect(lines).toEqual([
      { account_code: 'PLAYER_DEPOSITS', direction: 'DEBIT', amount: '500.00' },
      { account_code: 'PLAYER_LIABILITY', direction: 'CREDIT', amount: '500.00' },
    ]);
  }, 60_000);

  it('uma aposta debita o passivo do jogador e credita a receita da casa', async () => {
    const { walletId, playerId } = await createWallet('200.00');
    const res = await submit(walletId, playerId, `de-bet-${uniqSuffix()}`, 'BET', '30.00');

    const lines = await journalOf(res.body['transactionId'] as string);
    expect(lines).toEqual([
      { account_code: 'HOUSE_REVENUE', direction: 'CREDIT', amount: '30.00' },
      { account_code: 'PLAYER_LIABILITY', direction: 'DEBIT', amount: '30.00' },
    ]);
  }, 60_000);

  it('um ganho credita o passivo do jogador e debita os pagamentos da casa', async () => {
    const { walletId, playerId } = await createWallet('200.00');
    const res = await submit(walletId, playerId, `de-win-${uniqSuffix()}`, 'WIN', '45.00');

    const lines = await journalOf(res.body['transactionId'] as string);
    expect(lines).toEqual([
      { account_code: 'HOUSE_PAYOUT', direction: 'DEBIT', amount: '45.00' },
      { account_code: 'PLAYER_LIABILITY', direction: 'CREDIT', amount: '45.00' },
    ]);
  }, 60_000);

  it('LOSS não gera journal — não há movimento contábil', async () => {
    const { walletId, playerId } = await createWallet('200.00');
    const res = await submit(walletId, playerId, `de-loss-${uniqSuffix()}`, 'LOSS', '15.00');

    expect(await journalOf(res.body['transactionId'] as string)).toEqual([]);
  }, 60_000);

  it('todo journal fecha em zero: soma dos débitos == soma dos créditos', async () => {
    const { walletId, playerId } = await createWallet('500.00');
    const run = uniqSuffix();

    await submit(walletId, playerId, `bal-a-${run}`, 'BET', '10.00');
    await submit(walletId, playerId, `bal-b-${run}`, 'WIN', '25.00');
    await submit(walletId, playerId, `bal-c-${run}`, 'BET', '7.50');

    const unbalanced = await orm.em.getConnection().execute<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM (
         SELECT journal_entry_id
           FROM journal_lines
          GROUP BY journal_entry_id
         HAVING SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0
       ) AS bad`,
    );
    expect(Number(unbalanced[0]?.count ?? '0')).toBe(0);

    await assertWalletConsistency(orm, walletId);
  }, 90_000);

  it('o BANCO recusa um journal desbalanceado — trigger DEFERRABLE', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    // LOSS de propósito: não gera journal, então a UNIQUE(transaction_id) não
    // dispara antes da trigger que queremos exercitar.
    const res = await submit(walletId, playerId, `bad-${uniqSuffix()}`, 'LOSS', '10.00');
    const transactionId = res.body['transactionId'] as string;

    const entryId = uuid();
    let rejected = false;

    try {
      await orm.em.getConnection().transactional(async (tx) => {
        await orm.em.getConnection().execute(
          `INSERT INTO journal_entries (id, transaction_id, wallet_id, description, currency)
             VALUES (?, ?, ?, 'desbalanceado de propósito', 'BRL')`,
          [entryId, transactionId, walletId],
          'run',
          tx,
        );
        // Uma única perna: a soma não fecha.
        await orm.em.getConnection().execute(
          `INSERT INTO journal_lines (id, journal_entry_id, account_code, direction, amount, currency)
             VALUES (?, ?, 'HOUSE_REVENUE', 'CREDIT', '10.00', 'BRL')`,
          [uuid(), entryId],
          'run',
          tx,
        );
      });
    } catch (e) {
      rejected = true;
      expect(String(e)).toContain('desbalanceada');
    }

    expect(rejected).toBe(true);
  }, 60_000);

  it('o saldo do passivo do jogador espelha a soma das wallets', async () => {
    const totals = await orm.em.getConnection().execute<{ liability: string }[]>(
      `SELECT COALESCE(SUM(
                CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END
              ), 0)::text AS liability
         FROM journal_lines WHERE account_code = 'PLAYER_LIABILITY'`,
    );

    const wallets = await orm.em
      .getConnection()
      .execute<{ total: string }[]>(
        `SELECT COALESCE(SUM(balance_amount), 0)::text AS total FROM wallets`,
      );

    // O passivo total da casa é exatamente a soma dos saldos dos jogadores.
    expect(totals[0]?.liability).toBe(wallets[0]?.total);
  }, 60_000);
});
