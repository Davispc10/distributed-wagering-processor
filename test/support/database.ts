import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { buildMikroOrmConfig } from '@shared/persistence/mikroOrmConfig';
import { AppConfig } from '@shared/config/AppConfig';
import { loadEnv } from '@shared/config/env';

/**
 * Postgres e SQS reais: mocks não reproduzem `FOR UPDATE`, `SKIP LOCKED`, CHECK
 * nem trigger, que é justamente o que este projeto precisa provar.
 */
export const TEST_ENV = {
  POSTGRES_HOST: process.env['TEST_POSTGRES_HOST'] ?? 'localhost',
  POSTGRES_PORT: process.env['TEST_POSTGRES_PORT'] ?? '55432',
  POSTGRES_DB: process.env['TEST_POSTGRES_DB'] ?? 'wagering_test',
  POSTGRES_USER: 'wagering',
  POSTGRES_PASSWORD: 'wagering',
  AWS_ENDPOINT_URL: process.env['TEST_AWS_ENDPOINT_URL'] ?? 'http://localhost:54566',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
};

export function testAppConfig(overrides: Record<string, string> = {}): AppConfig {
  return new AppConfig(loadEnv({ ...process.env, ...TEST_ENV, ...overrides }));
}

let sharedOrm: MikroORM | null = null;

export async function getOrm(): Promise<MikroORM> {
  if (sharedOrm) return sharedOrm;
  sharedOrm = await MikroORM.init({
    ...buildMikroOrmConfig(testAppConfig()),
    allowGlobalContext: true,
  });
  await sharedOrm.getMigrator().up();
  return sharedOrm;
}

export async function closeOrm(): Promise<void> {
  if (sharedOrm) {
    await sharedOrm.close(true);
    sharedOrm = null;
  }
}

/**
 * `TRUNCATE` não dispara a trigger de imutabilidade, que é BEFORE UPDATE OR
 * DELETE por linha — por isso o ambiente de teste consegue limpar o ledger.
 */
export async function truncateAll(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute(`
    TRUNCATE TABLE
      wallet_ledger_entries,
      wager_transactions,
      wallets,
      inbox_messages,
      outbox_messages
    RESTART IDENTITY CASCADE
  `);
}

export function freshEm(orm: MikroORM): EntityManager {
  return orm.em.fork();
}

export const uuid = (): string => randomUUID();

/** A invariante que fecha TODO teste de integração e concorrência. */
export async function assertWalletConsistency(orm: MikroORM, walletId: string): Promise<void> {
  const rows = await orm.em
    .getConnection()
    .execute<{ stored: string; calculated: string; entry_count: string }[]>(
      `SELECT
       w.balance_amount::text AS stored,
       COALESCE((
         SELECT SUM(CASE l.direction WHEN 'CREDIT' THEN l.money_amount ELSE -l.money_amount END)
         FROM wallet_ledger_entries l WHERE l.wallet_id = w.id
       ), 0)::text AS calculated,
       (SELECT COUNT(*) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)::text AS entry_count
     FROM wallets w WHERE w.id = ?`,
      [walletId],
    );

  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} não encontrada`);

  const stored = Number(row.stored);
  const calculated = Number(row.calculated);

  if (stored !== calculated) {
    throw new Error(
      `INVARIANTE VIOLADA em ${walletId}: saldo materializado ${row.stored} != ` +
        `ledger reconstruído ${row.calculated} (${row.entry_count} lançamentos)`,
    );
  }
}
