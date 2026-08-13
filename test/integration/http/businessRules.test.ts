import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertWalletConsistency, closeOrm, getOrm, truncateAll } from '@test/support/database';
import { postJson, startInstance, stopAll, type AppInstance } from '@test/support/app';

/**
 * Regras da seção 7 e idempotência da seção 9 exercidas ponta a ponta contra
 * PostgreSQL real. Cada caso confere status + failureCode E o efeito no saldo e
 * no ledger: checar só o status esconderia o bug mais caro deste domínio —
 * responder 422 movendo o saldo, ou 201 sem gravar o lançamento.
 */

let orm: MikroORM;
let api: AppInstance;

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

interface SubmitOptions {
  kind: string;
  amount: string;
  externalId: string;
  currency?: string;
  playerId?: string;
  roundId?: string;
  reference?: string;
  idempotencyKey?: string;
}

async function submit(
  wallet: Wallet,
  options: SubmitOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await postJson(
    `${api.baseUrl}/wagering/transactions`,
    {
      providerId: 'provider-a',
      externalTransactionId: options.externalId,
      playerId: options.playerId ?? wallet.playerId,
      walletId: wallet.walletId,
      roundId: options.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: options.kind,
      money: { amount: options.amount, currency: options.currency ?? 'BRL' },
      ...(options.reference !== undefined
        ? { referenceExternalTransactionId: options.reference }
        : {}),
    },
    { 'Idempotency-Key': options.idempotencyKey ?? `provider-a:${options.externalId}` },
  );
  return { status: res.status, body: res.body as unknown as Record<string, unknown> };
}

const scalar = async (sql: string, params: unknown[] = []): Promise<string | null> => {
  const rows = await orm.em.getConnection().execute<{ value: string | null }[]>(sql, params);
  return rows[0]?.value ?? null;
};

const balanceOf = async (walletId: string): Promise<string | null> =>
  scalar(`SELECT balance_amount::text AS value FROM wallets WHERE id = ?`, [walletId]);

const ledgerCount = async (walletId: string): Promise<number> =>
  Number(
    await scalar(`SELECT COUNT(*)::text AS value FROM wallet_ledger_entries WHERE wallet_id = ?`, [
      walletId,
    ]),
  );

const transactionRow = async (
  externalId: string,
): Promise<{ status: string | null; failureCode: string | null }> => ({
  status: await scalar(
    `SELECT status AS value FROM wager_transactions WHERE external_transaction_id = ?`,
    [externalId],
  ),
  failureCode: await scalar(
    `SELECT failure_code AS value FROM wager_transactions WHERE external_transaction_id = ?`,
    [externalId],
  ),
});

const rejectedEventCount = async (externalId: string): Promise<number> =>
  Number(
    await scalar(
      `SELECT COUNT(*)::text AS value FROM outbox_messages
        WHERE event_type = 'WagerTransactionRejected'
          AND payload->'data'->>'externalTransactionId' = ?`,
      [externalId],
    ),
  );

beforeAll(async () => {
  orm = await getOrm();
  await truncateAll(orm);
  // Sem worker: a outbox fica intacta para inspeção, e nenhuma referência
  // pendente é resolvida por trás dos testes.
  api = await startInstance('src/main-api.ts', { name: 'rules-api', port: 4801 });
}, 120_000);

afterAll(async () => {
  await stopAll([api]);
  await closeOrm();
});

describe('idempotência — seção 9', () => {
  it('requisição idêntica devolve o resultado original com idempotentReplay', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `replay-${uniq()}`;

    const first = await submit(wallet, { kind: 'BET', amount: '30.00', externalId });
    expect(first.status).toBe(201);
    expect(first.body['idempotentReplay']).toBe(false);

    const second = await submit(wallet, { kind: 'BET', amount: '30.00', externalId });

    expect(second.status).toBe(200);
    expect(second.body['idempotentReplay']).toBe(true);
    expect(second.body['transactionId']).toBe(first.body['transactionId']);
    // Um único débito: o replay não move saldo.
    expect(await balanceOf(wallet.walletId)).toBe('70.00');
    expect(await ledgerCount(wallet.walletId)).toBe(2); // OPENING + BET
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);

  /** Regra 7.7: o saldo do replay é o observado na decisão, não o de agora. */
  it('o replay devolve o saldo daquele momento, mesmo após outras operações', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `replay-obs-${uniq()}`;

    const first = await submit(wallet, { kind: 'BET', amount: '10.00', externalId });
    expect((first.body['balance'] as { amount: string }).amount).toBe('90.00');

    // Uma segunda operação muda o saldo atual para 70.00.
    await submit(wallet, { kind: 'BET', amount: '20.00', externalId: `outra-${uniq()}` });
    expect(await balanceOf(wallet.walletId)).toBe('70.00');

    const replay = await submit(wallet, { kind: 'BET', amount: '10.00', externalId });

    expect(replay.body['idempotentReplay']).toBe(true);
    expect((replay.body['balance'] as { amount: string }).amount).toBe('90.00');
  }, 60_000);

  it('mesma key com payload diferente é 409, NÃO replay', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `conflict-${uniq()}`;

    expect((await submit(wallet, { kind: 'BET', amount: '30.00', externalId })).status).toBe(201);

    const conflict = await submit(wallet, {
      kind: 'BET',
      amount: '31.00', // valor diferente sob a MESMA idempotency key
      externalId,
      idempotencyKey: `provider-a:${externalId}`,
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body['failureCode']).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    // Nada mudou: o conflito não decide nada sobre a operação.
    expect(await balanceOf(wallet.walletId)).toBe('70.00');
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);

  it('kind diferente sob a mesma key também é conflito', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `conflict-kind-${uniq()}`;

    await submit(wallet, { kind: 'BET', amount: '30.00', externalId });
    const conflict = await submit(wallet, { kind: 'WIN', amount: '30.00', externalId });

    expect(conflict.status).toBe(409);
    expect(conflict.body['failureCode']).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  }, 60_000);

  /**
   * Duas unicidades distintas: a idempotency key e o par
   * (provider_id, external_transaction_id). Trocar a key só passa pela primeira;
   * quem barra é o índice do par. Sem tratar essa violação o provedor recebia
   * 500 — que sugere "tente de novo" — para um erro que reenviar jamais resolve.
   */
  it('mesmo externalTransactionId sob key DIFERENTE é 409, não 500', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `dup-external-${uniq()}`;

    expect((await submit(wallet, { kind: 'BET', amount: '30.00', externalId })).status).toBe(201);

    const conflict = await submit(wallet, {
      kind: 'BET',
      amount: '30.00',
      externalId,
      idempotencyKey: `provider-a:${externalId}:outra-key`,
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body['failureCode']).toBe('DUPLICATE_PROVIDER_TRANSACTION');
    // O débito original continua sendo o único.
    expect(await balanceOf(wallet.walletId)).toBe('70.00');
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);
});

describe('escopo da wallet — rejeição auditável', () => {
  /**
   * A rejeição precisa virar linha REJECTED com evento: um rollback silencioso
   * deixaria o provedor sem resposta em `GET /providers/:id/...`.
   */
  it('moeda divergente da wallet é REJECTED persistido, com evento', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `currency-${uniq()}`;

    const res = await submit(wallet, {
      kind: 'BET',
      amount: '10.00',
      externalId,
      currency: 'USD',
    });

    expect(res.status).toBe(422);
    expect(res.body['failureCode']).toBe('WALLET_CURRENCY_MISMATCH');

    const row = await transactionRow(externalId);
    expect(row.status).toBe('REJECTED');
    expect(row.failureCode).toBe('WALLET_CURRENCY_MISMATCH');
    expect(await rejectedEventCount(externalId)).toBe(1);

    // Sem lançamento e sem mudança de saldo (regra 7.6).
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await ledgerCount(wallet.walletId)).toBe(1); // só o OPENING
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);

  it('wallet de outro player é REJECTED persistido', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `player-${uniq()}`;

    const res = await submit(wallet, {
      kind: 'BET',
      amount: '10.00',
      externalId,
      playerId: crypto.randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(res.body['failureCode']).toBe('PLAYER_WALLET_MISMATCH');

    const row = await transactionRow(externalId);
    expect(row.status).toBe('REJECTED');
    expect(row.failureCode).toBe('PLAYER_WALLET_MISMATCH');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  }, 60_000);

  /** Rejeição é terminal: reenviar devolve a MESMA decisão, sem reprocessar. */
  it('reenviar a operação rejeitada devolve o replay da rejeição', async () => {
    const wallet = await createWallet('100.00');
    const externalId = `currency-replay-${uniq()}`;
    const payload = { kind: 'BET', amount: '10.00', externalId, currency: 'USD' } as const;

    expect((await submit(wallet, payload)).status).toBe(422);
    const again = await submit(wallet, payload);

    expect(again.status).toBe(422);
    expect(again.body['idempotentReplay']).toBe(true);
    expect(again.body['failureCode']).toBe('WALLET_CURRENCY_MISMATCH');
  }, 60_000);
});

describe('REFUND e ROLLBACK — regras 7.1 a 7.5', () => {
  it('REFUND credita de volta a BET e só pode acontecer uma vez', async () => {
    const wallet = await createWallet('100.00');
    const betId = `bet-${uniq()}`;

    await submit(wallet, { kind: 'BET', amount: '40.00', externalId: betId });
    expect(await balanceOf(wallet.walletId)).toBe('60.00');

    const refund = await submit(wallet, {
      kind: 'REFUND',
      amount: '40.00',
      externalId: `refund-${uniq()}`,
      reference: betId,
    });

    expect(refund.status).toBe(201);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');

    const second = await submit(wallet, {
      kind: 'REFUND',
      amount: '40.00',
      externalId: `refund2-${uniq()}`,
      reference: betId,
    });

    expect(second.status).toBe(422);
    expect(second.body['failureCode']).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);

  it('REFUND não reverte WIN — só BET (regra 7.3)', async () => {
    const wallet = await createWallet('100.00');
    const winId = `win-${uniq()}`;

    await submit(wallet, { kind: 'WIN', amount: '50.00', externalId: winId });

    const refund = await submit(wallet, {
      kind: 'REFUND',
      amount: '50.00',
      externalId: `refund-win-${uniq()}`,
      reference: winId,
    });

    expect(refund.status).toBe(422);
    expect(refund.body['failureCode']).toBe('REFERENCE_KIND_NOT_REVERSIBLE');
    expect(await balanceOf(wallet.walletId)).toBe('150.00');
  }, 60_000);

  it('ROLLBACK de um WIN debita — inverte a direção da referência', async () => {
    const wallet = await createWallet('100.00');
    const winId = `win-rb-${uniq()}`;

    await submit(wallet, { kind: 'WIN', amount: '50.00', externalId: winId });
    expect(await balanceOf(wallet.walletId)).toBe('150.00');

    const rollback = await submit(wallet, {
      kind: 'ROLLBACK',
      amount: '50.00',
      externalId: `rb-${uniq()}`,
      reference: winId,
    });

    expect(rollback.status).toBe(201);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);

  it('reversão parcial é recusada (regra 7.5)', async () => {
    const wallet = await createWallet('100.00');
    const betId = `bet-partial-${uniq()}`;

    await submit(wallet, { kind: 'BET', amount: '40.00', externalId: betId });

    const refund = await submit(wallet, {
      kind: 'REFUND',
      amount: '10.00',
      externalId: `refund-partial-${uniq()}`,
      reference: betId,
    });

    expect(refund.status).toBe(422);
    expect(refund.body['failureCode']).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect(await balanceOf(wallet.walletId)).toBe('60.00');
  }, 60_000);

  it('referência de outra rodada é recusada por escopo (regra 7.2)', async () => {
    const wallet = await createWallet('100.00');
    const betId = `bet-scope-${uniq()}`;

    await submit(wallet, {
      kind: 'BET',
      amount: '40.00',
      externalId: betId,
      roundId: 'round-A',
    });

    const refund = await submit(wallet, {
      kind: 'REFUND',
      amount: '40.00',
      externalId: `refund-scope-${uniq()}`,
      reference: betId,
      roundId: 'round-B',
    });

    expect(refund.status).toBe(422);
    expect(refund.body['failureCode']).toBe('REFERENCE_SCOPE_MISMATCH');
  }, 60_000);

  /** Regra 7.9: reversão sem saldo tem código próprio, distinto de aposta sem saldo. */
  it('ROLLBACK que deixaria a wallet negativa usa REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await createWallet('0.00');
    const winId = `win-neg-${uniq()}`;

    await submit(wallet, { kind: 'WIN', amount: '50.00', externalId: winId });
    // O jogador aposta o que ganhou: não há mais como desfazer o WIN.
    await submit(wallet, { kind: 'BET', amount: '45.00', externalId: `bet-neg-${uniq()}` });
    expect(await balanceOf(wallet.walletId)).toBe('5.00');

    const rollback = await submit(wallet, {
      kind: 'ROLLBACK',
      amount: '50.00',
      externalId: `rb-neg-${uniq()}`,
      reference: winId,
    });

    expect(rollback.status).toBe(422);
    expect(rollback.body['failureCode']).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await balanceOf(wallet.walletId)).toBe('5.00');
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);

  it('aposta sem saldo usa INSUFFICIENT_FUNDS — código diferente do de reversão', async () => {
    const wallet = await createWallet('10.00');

    const bet = await submit(wallet, {
      kind: 'BET',
      amount: '999.00',
      externalId: `bet-nofunds-${uniq()}`,
    });

    expect(bet.status).toBe(422);
    expect(bet.body['failureCode']).toBe('INSUFFICIENT_FUNDS');
  }, 60_000);
});

describe('LOSS — registra o desfecho sem mover saldo', () => {
  it('não gera lançamento e não altera a version da wallet', async () => {
    const wallet = await createWallet('100.00');

    const res = await submit(wallet, {
      kind: 'LOSS',
      amount: '30.00',
      externalId: `loss-${uniq()}`,
    });

    expect(res.status).toBe(201);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    expect(await ledgerCount(wallet.walletId)).toBe(1); // só o OPENING
    expect(
      await scalar(`SELECT version::text AS value FROM wallets WHERE id = ?`, [wallet.walletId]),
    ).toBe('1');
    await assertWalletConsistency(orm, wallet.walletId);
  }, 60_000);
});

/**
 * Estes casos existem porque uma varredura de cobertura mostrou que 404 e o
 * conflito de wallet nunca eram exercidos: a suíte assertava 200, 201, 202, 400,
 * 409 e 422, e nenhum 404. Status sem teste é status sem contrato.
 */
describe('erros de recurso — 404 e conflito de wallet', () => {
  it('submeter para wallet inexistente é 404 WALLET_NOT_FOUND', async () => {
    const res = await postJson(
      `${api.baseUrl}/wagering/transactions`,
      {
        providerId: 'provider-a',
        externalTransactionId: `ghost-${uniq()}`,
        playerId: crypto.randomUUID(),
        // UUIDv7 bem formado e inexistente: passa no ParseUUIDPipe e morre no use case.
        walletId: '019ffff0-0000-7000-8000-00000000dead',
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      { 'Idempotency-Key': `provider-a:ghost-${uniq()}` },
    );

    expect(res.status).toBe(404);
    expect((res.body as unknown as Record<string, unknown>)['failureCode']).toBe(
      'WALLET_NOT_FOUND',
    );
  }, 60_000);

  it('segunda wallet para o mesmo player e moeda é 409 WALLET_ALREADY_EXISTS', async () => {
    const playerId = crypto.randomUUID();
    const body = { playerId, initialBalance: { amount: '50.00', currency: 'BRL' } };

    expect((await postJson(`${api.baseUrl}/wallets`, body)).status).toBe(201);

    // Barrado por `wallets_player_currency_uk`. A constraint tinha tratamento no
    // código, mas nenhum teste — a mesma lacuna que deixou passar o 500 do
    // externalTransactionId duplicado.
    const conflict = await postJson(`${api.baseUrl}/wallets`, body);

    expect(conflict.status).toBe(409);
    expect((conflict.body as unknown as Record<string, unknown>)['failureCode']).toBe(
      'WALLET_ALREADY_EXISTS',
    );
  }, 60_000);

  it('Idempotency-Key ausente é 400, não 500', async () => {
    const wallet = await createWallet('100.00');

    const res = await postJson(`${api.baseUrl}/wagering/transactions`, {
      providerId: 'provider-a',
      externalTransactionId: `no-key-${uniq()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(res.status).toBe(400);
    expect((res.body as unknown as Record<string, unknown>)['failureCode']).toBe(
      'VALIDATION_ERROR',
    );
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  }, 60_000);
});
