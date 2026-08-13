import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertWalletConsistency, closeOrm, getOrm, truncateAll } from '@test/support/database';
import { postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';

/**
 * O caminho terminal do fluxo fora de ordem: a referência nunca chega e o
 * `PendingReferenceWorker` precisa desistir com `REFERENCE_NOT_FOUND`.
 *
 * Arquivo separado de `businessRules.test.ts` de propósito: aquele NÃO sobe
 * worker, justamente para nenhuma referência pendente ser resolvida por trás
 * dos testes. Aqui a premissa é a oposta.
 *
 * O worker sobe com `PENDING_REFERENCE_MAX_ATTEMPTS=1` e backoff de 1s. Com o
 * padrão (8 tentativas, teto de 60s) o caso levaria ~15 min de relógio.
 */

let orm: MikroORM;
let api: AppInstance;
let worker: AppInstance;

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

interface TransactionRow {
  status: string;
  failure_code: string | null;
}

async function rowOf(externalId: string): Promise<TransactionRow | undefined> {
  const rows = await orm.em
    .getConnection()
    .execute<TransactionRow[]>(
      `SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ?`,
      [externalId],
    );
  return rows[0];
}

/** Espera por condição em vez de dormir um tempo fixo: o worker é assíncrono. */
async function waitForTerminal(externalId: string, timeoutMs = 60_000): Promise<TransactionRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = await rowOf(externalId);
    if (row && row.status !== 'PENDING_REFERENCE') return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`transação ${externalId} não saiu de PENDING_REFERENCE a tempo`);
}

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);

  api = await startInstance('src/main-api.ts', { name: 'pref-api', port: 4821 });
  worker = await startInstance('src/main-worker.ts', {
    name: 'pref-worker',
    port: 4822,
    env: {
      PENDING_REFERENCE_MAX_ATTEMPTS: '1',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '500',
      PENDING_REFERENCE_BACKOFF_CAP_SECONDS: '1',
    },
  });
}, 120_000);

afterAll(async () => {
  await stopAll([api, worker]);
  await closeOrm();
});

describe('referência que nunca chega — REFERENCE_NOT_FOUND', () => {
  it('202 vira REJECTED terminal depois de esgotar as tentativas', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `orphan-rollback-${uniq()}`;

    const accepted = await postJson(
      `${api.baseUrl}/wagering/transactions`,
      {
        providerId: 'provider-a',
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'ROLLBACK',
        money: { amount: '10.00', currency: 'BRL' },
        // Referência que não existe e nunca vai existir.
        referenceExternalTransactionId: `never-arrives-${uniq()}`,
      },
      { 'Idempotency-Key': `provider-a:${externalId}` },
    );

    expect(accepted.status).toBe(202);

    const row = await waitForTerminal(externalId);

    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');

    // Rejeição não move dinheiro: o saldo segue só com o OPENING.
    await assertWalletConsistency(orm, wallet.walletId);
  }, 120_000);
});
