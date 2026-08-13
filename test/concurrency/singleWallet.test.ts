import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertWalletConsistency, closeOrm, getOrm, truncateAll } from '@test/support/database';
import { postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';

/**
 * Cenários 1, 2 e 3 da seção 13 — paralelismo REAL contra Postgres real.
 *
 * Toda concorrência aqui dispara de uma **barreira de largada** comum: sem ela,
 * a primeira requisição sairia com vantagem e o teste não exercitaria a
 * contenção que deveria testar.
 *
 * As asserções são sobre **invariantes**, nunca sobre ordem. "Exatamente uma
 * processou" é determinístico; "a primeira processou" não é, e assertar isso
 * produziria um teste instável que esconderia regressões reais atrás de
 * re-execuções.
 */

let orm: MikroORM;
const instances: AppInstance[] = [];

const API_PORTS = [4501, 4502, 4503];

async function createWallet(balance: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = crypto.randomUUID();
  const res = await postJson(`${instances[0]!.baseUrl}/wallets`, {
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  if (res.body.id === undefined)
    throw new Error(`falha ao criar wallet: ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

interface BetOptions {
  baseUrl: string;
  walletId: string;
  playerId: string;
  externalId: string;
  idempotencyKey: string;
  amount: string;
}

async function submitBet(
  o: BetOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await postJson(
    `${o.baseUrl}/wagering/transactions`,
    {
      providerId: 'provider-a',
      externalTransactionId: o.externalId,
      playerId: o.playerId,
      walletId: o.walletId,
      roundId: 'round-conc',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: o.amount, currency: 'BRL' },
    },
    { 'Idempotency-Key': o.idempotencyKey },
  );
  return { status: res.status, body: res.body as unknown as Record<string, unknown> };
}

async function ledgerDebits(walletId: string): Promise<number> {
  const rows = await orm.em.getConnection().execute<{ count: string }[]>(
    `SELECT COUNT(*)::text AS count FROM wallet_ledger_entries
      WHERE wallet_id = ? AND direction = 'DEBIT'`,
    [walletId],
  );
  return Number(rows[0]?.count ?? '0');
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = await orm.em
    .getConnection()
    .execute<{ balance_amount: string }[]>(
      `SELECT balance_amount::text FROM wallets WHERE id = ?`,
      [walletId],
    );
  return rows[0]?.balance_amount ?? 'n/a';
}

/** Barreira de largada: todas as tarefas esperam a mesma Promise. */
function startingGate(): { wait: () => Promise<void>; fire: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: () => gate,
    fire: () => {
      release();
    },
  };
}

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);

  // Três instâncias de API: as requisições concorrentes se espalham entre
  // processos distintos, então o lock disputado é o do PostgreSQL, não um
  // mutex de processo.
  for (const [index, port] of API_PORTS.entries()) {
    instances.push(
      await startInstance('src/main-api.ts', { name: `conc-api-${String(index + 1)}`, port }),
    );
  }
}, 120_000);

afterAll(async () => {
  await stopAll(instances);
  await closeOrm();
});

describe('cenário 1 — a mesma aposta enviada 50 vezes em paralelo', () => {
  it('produz UM único débito; as outras 49 são replay', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const externalId = `same-bet-${String(Date.now())}`;
    const key = `provider-a:${externalId}`;
    const gate = startingGate();

    const attempts = Array.from({ length: 50 }, (_, i) =>
      (async () => {
        await gate.wait();
        return submitBet({
          baseUrl: instances[i % instances.length]!.baseUrl,
          walletId,
          playerId,
          externalId,
          idempotencyKey: key,
          amount: '25.00',
        });
      })(),
    );

    gate.fire();
    const results = await Promise.all(attempts);

    const created = results.filter((r) => r.status === 201);
    const replays = results.filter((r) => r.status === 200);
    const transient = results.filter((r) => r.status === 503);

    // Um 503 aqui é aceitável (contenção → erro transitório retentável) e o
    // provedor reenviaria. O que NÃO é aceitável é débito duplicado.
    expect(created.length + replays.length + transient.length).toBe(50);
    expect(created.length).toBeLessThanOrEqual(1);

    expect(await ledgerDebits(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('975.00');

    const transactionIds = new Set(
      results
        .filter((r) => r.status === 200 || r.status === 201)
        .map((r) => r.body['transactionId'] as string),
    );
    expect(transactionIds.size).toBe(1);

    await assertWalletConsistency(orm, walletId);
  }, 120_000);
});

describe('cenário 2 — cenário obrigatório da seção 8', () => {
  it('saldo 100.00, duas apostas de 80.00 simultâneas: uma processa, uma é rejeitada, saldo 20.00', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const run = String(Date.now());
    const gate = startingGate();

    const [a, b] = await (async () => {
      const tasks = ['a', 'b'].map((suffix, i) =>
        (async () => {
          await gate.wait();
          return submitBet({
            baseUrl: instances[i]!.baseUrl,
            walletId,
            playerId,
            externalId: `race-${run}-${suffix}`,
            idempotencyKey: `provider-a:race-${run}-${suffix}`,
            amount: '80.00',
          });
        })(),
      );
      gate.fire();
      return Promise.all(tasks);
    })();

    const statuses = [a!.status, b!.status].sort((x, y) => x - y);

    // Exatamente uma PROCESSED (201) e uma REJECTED (422).
    expect(statuses).toEqual([201, 422]);

    const rejected = [a!, b!].find((r) => r.status === 422);
    expect(rejected?.body['failureCode']).toBe('INSUFFICIENT_FUNDS');

    expect(await balanceOf(walletId)).toBe('20.00');
    // Exatamente UM lançamento de débito — nenhum retry duplicou nada.
    expect(await ledgerDebits(walletId)).toBe(1);

    await assertWalletConsistency(orm, walletId);
  }, 120_000);

  it('vale para qualquer número de disputantes: 10 apostas de 80.00 sobre saldo 100.00', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const run = String(Date.now());
    const gate = startingGate();

    const tasks = Array.from({ length: 10 }, (_, i) =>
      (async () => {
        await gate.wait();
        return submitBet({
          baseUrl: instances[i % instances.length]!.baseUrl,
          walletId,
          playerId,
          externalId: `many-${run}-${String(i)}`,
          idempotencyKey: `provider-a:many-${run}-${String(i)}`,
          amount: '80.00',
        });
      })(),
    );

    gate.fire();
    const results = await Promise.all(tasks);

    const processed = results.filter((r) => r.status === 201);
    expect(processed.length).toBe(1);
    expect(await balanceOf(walletId)).toBe('20.00');
    expect(await ledgerDebits(walletId)).toBe(1);
    await assertWalletConsistency(orm, walletId);
  }, 120_000);
});

describe('cenário 3 — wallets distintas em paralelo', () => {
  it('não interferem entre si e todas terminam consistentes', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet('500.00')));
    const run = String(Date.now());
    const gate = startingGate();

    const tasks = wallets.flatMap(({ walletId, playerId }, w) =>
      Array.from({ length: 5 }, (_, i) =>
        (async () => {
          await gate.wait();
          return submitBet({
            baseUrl: instances[(w + i) % instances.length]!.baseUrl,
            walletId,
            playerId,
            externalId: `multi-${run}-${String(w)}-${String(i)}`,
            idempotencyKey: `provider-a:multi-${run}-${String(w)}-${String(i)}`,
            amount: '10.00',
          });
        })(),
      ),
    );

    gate.fire();
    const results = await Promise.all(tasks);

    expect(results.every((r) => r.status === 201)).toBe(true);

    for (const { walletId } of wallets) {
      expect(await balanceOf(walletId)).toBe('450.00');
      expect(await ledgerDebits(walletId)).toBe(5);
      await assertWalletConsistency(orm, walletId);
    }
  }, 180_000);
});

describe('reconciliação após a bateria de concorrência', () => {
  it('toda wallet tocada continua com saldo == ledger', async () => {
    const rows = await orm.em.getConnection().execute<{ id: string }[]>(`SELECT id FROM wallets`);

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const res = await postJson(`${instances[0]!.baseUrl}/wallets/${row.id}/reconciliation`, {});
      expect(res.body.consistent).toBe(true);
    }
  }, 120_000);
});
