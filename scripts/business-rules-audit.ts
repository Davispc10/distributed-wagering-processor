/**
 * Relatório executável das regras de negócio contra a stack real.
 *
 * Cada caso verifica status + failureCode, efeito no saldo E contagem de
 * lançamentos: checar só o status esconderia o bug mais caro deste domínio —
 * responder 201 sem gravar o lançamento, ou 422 movendo o saldo.
 *
 * Uso: bun run audit:business-rules
 */
import { MikroORM } from '@mikro-orm/postgresql';
import {
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { AppConfig } from '@shared/config/AppConfig';
import { loadEnv } from '@shared/config/env';
import { buildMikroOrmConfig } from '@shared/persistence/mikroOrmConfig';

const API = process.env['AUDIT_API_URL'] ?? 'http://localhost:3400';
const SQS_ENDPOINT = process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566';
const PROVIDER = 'provider-a';
const OTHER_PROVIDER = 'provider-b';

const sqs = new SQSClient({
  endpoint: SQS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

let orm: MikroORM;
const run = Date.now().toString(36);
let seq = 0;
const nextId = (label: string): string => `${label}-${run}-${(seq++).toString(36)}`;

interface Case {
  section: string;
  name: string;
  expected: string;
  actual: string;
  passed: boolean;
}

const cases: Case[] = [];

function record(section: string, name: string, expected: string, actual: string): void {
  cases.push({ section, name, expected, actual, passed: expected === actual });
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<HttpResult> {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface Wallet {
  walletId: string;
  playerId: string;
}

async function openWallet(amount: string, currency = 'BRL'): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const res = await post('/wallets', {
    playerId,
    initialBalance: { amount, currency },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`falha ao abrir wallet: ${String(res.status)} ${JSON.stringify(res.body)}`);
  }
  return { walletId: res.body['id'] as string, playerId };
}

interface SubmitOptions {
  wallet: Wallet;
  kind: string;
  amount: string;
  currency?: string;
  externalId?: string;
  idempotencyKey?: string;
  reference?: string;
  roundId?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
}

function bodyOf(o: SubmitOptions): Record<string, unknown> {
  const externalId = o.externalId ?? nextId('tx');
  return {
    providerId: o.providerId ?? PROVIDER,
    externalTransactionId: externalId,
    playerId: o.playerId ?? o.wallet.playerId,
    walletId: o.walletId ?? o.wallet.walletId,
    roundId: o.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: o.kind,
    money: { amount: o.amount, currency: o.currency ?? 'BRL' },
    ...(o.reference !== undefined ? { referenceExternalTransactionId: o.reference } : {}),
  };
}

async function submit(o: SubmitOptions): Promise<HttpResult & { externalId: string }> {
  const body = bodyOf(o);
  const externalId = body['externalTransactionId'] as string;
  const key = o.idempotencyKey ?? `${String(body['providerId'])}:${externalId}`;
  const res = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
  return { ...res, externalId };
}

async function stateOf(walletId: string): Promise<{ balance: string; entries: number }> {
  const rows = await orm.em.getConnection().execute<{ balance: string; entries: string }[]>(
    `SELECT w.balance_amount::text AS balance,
            (SELECT COUNT(*) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)::text AS entries
       FROM wallets w WHERE w.id = ?`,
    [walletId],
  );
  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} não encontrada`);
  return { balance: row.balance, entries: Number(row.entries) };
}

async function describe(res: HttpResult, walletId: string): Promise<string> {
  const state = await stateOf(walletId);
  const code = res.body['failureCode'];
  const marker = typeof code === 'string' ? `/${code}` : '';
  return `${String(res.status)}${marker} saldo=${state.balance} ledger=${String(state.entries)}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T | null>,
  { timeoutMs = 45_000, intervalMs = 250, what = 'condição' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout aguardando: ${what}`);
}

async function transactionStatus(idempotencyKey: string): Promise<string | null> {
  const rows = await orm.em
    .getConnection()
    .execute<{ status: string }[]>(
      `SELECT status FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
  return rows[0]?.status ?? null;
}

/** §7 — BET */
async function auditBet(): Promise<void> {
  const w = await openWallet('100.00');

  const ok = await submit({ wallet: w, kind: 'BET', amount: '25.00' });
  record(
    '§7 BET',
    'debita e gera 1 lançamento',
    '201 saldo=75.00 ledger=2',
    await describe(ok, w.walletId),
  );

  const noFunds = await submit({ wallet: w, kind: 'BET', amount: '9999.00' });
  record(
    '§7 BET',
    'saldo insuficiente é rejeitado sem mover saldo',
    '422/INSUFFICIENT_FUNDS saldo=75.00 ledger=2',
    await describe(noFunds, w.walletId),
  );

  const exact = await submit({ wallet: w, kind: 'BET', amount: '75.00' });
  record(
    '§7 BET',
    'permite zerar o saldo exatamente',
    '201 saldo=0.00 ledger=3',
    await describe(exact, w.walletId),
  );

  const overZero = await submit({ wallet: w, kind: 'BET', amount: '0.01' });
  record(
    '§7 BET',
    'com saldo zero, qualquer aposta é rejeitada',
    '422/INSUFFICIENT_FUNDS saldo=0.00 ledger=3',
    await describe(overZero, w.walletId),
  );
}

/** §7 — WIN e LOSS */
async function auditWinAndLoss(): Promise<void> {
  const w = await openWallet('100.00');

  const win = await submit({ wallet: w, kind: 'WIN', amount: '50.00' });
  record(
    '§7 WIN',
    'credita e gera 1 lançamento',
    '201 saldo=150.00 ledger=2',
    await describe(win, w.walletId),
  );

  const loss = await submit({ wallet: w, kind: 'LOSS', amount: '30.00' });
  record(
    '§7 LOSS',
    'registra o desfecho SEM mover saldo e SEM lançamento',
    '201 saldo=150.00 ledger=2',
    await describe(loss, w.walletId),
  );

  // LOSS não muda o saldo, logo não pode incrementar a version (§6.2).
  const versionRows = await orm.em
    .getConnection()
    .execute<{ version: number }[]>(`SELECT version FROM wallets WHERE id = ?`, [w.walletId]);
  record(
    '§6.2 version',
    'LOSS não incrementa a version da wallet',
    'version=2',
    `version=${String(versionRows[0]?.version)}`,
  );

  // LOSS não move saldo, logo não emite WalletBalanceChanged (§11).
  const events = await orm.em.getConnection().execute<{ event_type: string }[]>(
    `SELECT event_type FROM outbox_messages
      WHERE payload->'data'->>'transactionId' = ?`,
    [loss.body['transactionId'] as string],
  );
  const types = events.map((e) => e.event_type).sort();
  record(
    '§11 eventos',
    'LOSS publica Processed mas NÃO WalletBalanceChanged',
    'WagerTransactionProcessed',
    types.join(','),
  );
}

/** §7.3, §7.4, §7.5 — REFUND */
async function auditRefund(): Promise<void> {
  const w = await openWallet('200.00');
  const bet = await submit({ wallet: w, kind: 'BET', amount: '40.00' });

  const refund = await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '40.00',
    reference: bet.externalId,
  });
  record(
    '§7 REFUND',
    'reverte a BET e devolve o valor',
    '201 saldo=200.00 ledger=3',
    await describe(refund, w.walletId),
  );

  const second = await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '40.00',
    reference: bet.externalId,
  });
  record(
    '§7.4 dupla reversão',
    'segundo REFUND da mesma BET é rejeitado',
    '422/REFERENCE_ALREADY_REVERSED saldo=200.00 ledger=3',
    await describe(second, w.walletId),
  );

  const partial = await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '10.00',
    reference: bet.externalId,
  });
  record(
    '§7.5 reversão parcial',
    'valor diferente da referência é rejeitado',
    '422/REFERENCE_AMOUNT_MISMATCH saldo=200.00 ledger=3',
    await describe(partial, w.walletId),
  );

  // §7.3: REFUND só referencia BET.
  const win = await submit({ wallet: w, kind: 'WIN', amount: '15.00' });
  const refundOfWin = await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '15.00',
    reference: win.externalId,
  });
  record(
    '§7.3 kind reversível',
    'REFUND de WIN é rejeitado',
    '422/REFERENCE_KIND_NOT_REVERSIBLE saldo=215.00 ledger=4',
    await describe(refundOfWin, w.walletId),
  );

  const noRef = await post(
    '/wagering/transactions',
    {
      providerId: PROVIDER,
      externalTransactionId: nextId('tx'),
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'g',
      kind: 'REFUND',
      money: { amount: '10.00', currency: 'BRL' },
    },
    { 'Idempotency-Key': `${PROVIDER}:${nextId('key')}` },
  );
  record(
    '§7.1 referência obrigatória',
    'REFUND sem referenceExternalTransactionId é rejeitado',
    '422/REFERENCE_REQUIRED',
    `${String(noRef.status)}/${String(noRef.body['failureCode'])}`,
  );
}

/** §7 — ROLLBACK */
async function auditRollback(): Promise<void> {
  const w = await openWallet('300.00');

  // ROLLBACK de BET credita (inverte o débito).
  const bet = await submit({ wallet: w, kind: 'BET', amount: '50.00' });
  const rbBet = await submit({
    wallet: w,
    kind: 'ROLLBACK',
    amount: '50.00',
    reference: bet.externalId,
  });
  record(
    '§7 ROLLBACK',
    'de BET credita (inverte o débito)',
    '201 saldo=300.00 ledger=3',
    await describe(rbBet, w.walletId),
  );

  // ROLLBACK de WIN debita (inverte o crédito).
  const win = await submit({ wallet: w, kind: 'WIN', amount: '80.00' });
  const rbWin = await submit({
    wallet: w,
    kind: 'ROLLBACK',
    amount: '80.00',
    reference: win.externalId,
  });
  record(
    '§7 ROLLBACK',
    'de WIN debita (inverte o crédito)',
    '201 saldo=300.00 ledger=5',
    await describe(rbWin, w.walletId),
  );

  // ROLLBACK de REFUND — permitido (§7.3).
  const bet2 = await submit({ wallet: w, kind: 'BET', amount: '20.00', roundId: 'round-2' });
  const refund2 = await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '20.00',
    reference: bet2.externalId,
    roundId: 'round-2',
  });
  const rbRefund = await submit({
    wallet: w,
    kind: 'ROLLBACK',
    amount: '20.00',
    reference: refund2.externalId,
    roundId: 'round-2',
  });
  record(
    '§7.3 kind reversível',
    'ROLLBACK de REFUND é permitido e debita',
    '201 saldo=280.00 ledger=8',
    await describe(rbRefund, w.walletId),
  );

  // §7.4: um REFUND e um ROLLBACK da MESMA referência são permitidos (tipos diferentes).
  const bet3 = await submit({ wallet: w, kind: 'BET', amount: '10.00', roundId: 'round-3' });
  await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '10.00',
    reference: bet3.externalId,
    roundId: 'round-3',
  });
  const rbSame = await submit({
    wallet: w,
    kind: 'ROLLBACK',
    amount: '10.00',
    reference: bet3.externalId,
    roundId: 'round-3',
  });
  record(
    '§7.4 dupla reversão',
    'REFUND e ROLLBACK da mesma referência são permitidos (tipos distintos)',
    '201 saldo=290.00 ledger=11',
    await describe(rbSame, w.walletId),
  );
}

/** §7.9 — REVERSAL_INSUFFICIENT_FUNDS distinto de INSUFFICIENT_FUNDS */
async function auditReversalInsufficientFunds(): Promise<void> {
  const w = await openWallet('100.00');

  // Ganha 500 e gasta tudo: o ROLLBACK do WIN deixaria a wallet negativa.
  const win = await submit({ wallet: w, kind: 'WIN', amount: '500.00' });
  await submit({ wallet: w, kind: 'BET', amount: '580.00' });

  const rollback = await submit({
    wallet: w,
    kind: 'ROLLBACK',
    amount: '500.00',
    reference: win.externalId,
  });

  record(
    '§7.9 código distinto',
    'reversão que deixaria a wallet negativa usa REVERSAL_INSUFFICIENT_FUNDS',
    '422/REVERSAL_INSUFFICIENT_FUNDS saldo=20.00 ledger=3',
    await describe(rollback, w.walletId),
  );
}

/** §7.2 — escopo da referência */
async function auditReferenceScope(): Promise<void> {
  const w = await openWallet('200.00');
  const bet = await submit({ wallet: w, kind: 'BET', amount: '30.00', roundId: 'round-scope' });

  // Outro provedor: a busca é por (provider, externalId), então nem encontra.
  const otherProvider = await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '30.00',
    reference: bet.externalId,
    providerId: OTHER_PROVIDER,
    roundId: 'round-scope',
  });
  record(
    '§7.2 escopo',
    'referência de outro provedor não é encontrada → PENDING_REFERENCE',
    '202 saldo=170.00 ledger=2',
    await describe(otherProvider, w.walletId),
  );

  // Rodada diferente: encontrada, mas fora do escopo.
  const otherRound = await submit({
    wallet: w,
    kind: 'REFUND',
    amount: '30.00',
    reference: bet.externalId,
    roundId: 'round-OUTRA',
  });
  record(
    '§7.2 escopo',
    'referência de outra rodada é rejeitada',
    '422/REFERENCE_SCOPE_MISMATCH saldo=170.00 ledger=2',
    await describe(otherRound, w.walletId),
  );

  // Wallet diferente (outro player): fora do escopo.
  const other = await openWallet('50.00');
  const otherWallet = await submit({
    wallet: other,
    kind: 'REFUND',
    amount: '30.00',
    reference: bet.externalId,
    roundId: 'round-scope',
  });
  record(
    '§7.2 escopo',
    'referência de outra wallet/player é rejeitada',
    '422/REFERENCE_SCOPE_MISMATCH saldo=50.00 ledger=1',
    await describe(otherWallet, other.walletId),
  );
}

/** §7.8 e §7.1 — referência fora de ordem */
async function auditOutOfOrderReference(): Promise<void> {
  const w = await openWallet('200.00');
  const futureBet = nextId('late-bet');

  const rollback = await submit({
    wallet: w,
    kind: 'ROLLBACK',
    amount: '35.00',
    reference: futureBet,
    roundId: 'round-late',
  });
  record(
    '§7.8 fora de ordem',
    'referência ausente → PENDING_REFERENCE, sem mover saldo',
    '202 saldo=200.00 ledger=1',
    await describe(rollback, w.walletId),
  );

  const pendingEvent = await orm.em.getConnection().execute<{ count: string }[]>(
    `SELECT COUNT(*)::text AS count FROM outbox_messages
      WHERE event_type = 'WagerTransactionPendingReference'
        AND payload->'data'->>'transactionId' = ?`,
    [rollback.body['transactionId'] as string],
  );
  record(
    '§11 eventos',
    'PENDING_REFERENCE publica WagerTransactionPendingReference',
    '1',
    pendingEvent[0]?.count ?? '0',
  );

  await submit({
    wallet: w,
    kind: 'BET',
    amount: '35.00',
    externalId: futureBet,
    roundId: 'round-late',
  });

  const rollbackKey = `${PROVIDER}:${rollback.externalId}`;
  await waitFor(
    async () => ((await transactionStatus(rollbackKey)) === 'PROCESSED' ? true : null),
    { what: 'PendingReferenceWorker resolver o ROLLBACK' },
  );

  const state = await stateOf(w.walletId);
  record(
    '§7.8 fora de ordem',
    'worker resolve quando a referência chega e devolve o valor',
    'saldo=200.00 ledger=3',
    `saldo=${state.balance} ledger=${String(state.entries)}`,
  );
}

/** §9 — idempotência */
async function auditIdempotency(): Promise<void> {
  const w = await openWallet('100.00');
  const externalId = nextId('idem');
  const key = `${PROVIDER}:${externalId}`;

  const first = await submit({
    wallet: w,
    kind: 'BET',
    amount: '20.00',
    externalId,
    idempotencyKey: key,
  });
  record(
    '§9 idempotência',
    'primeira submissão processa',
    '201 saldo=80.00 ledger=2',
    await describe(first, w.walletId),
  );

  const replay = await submit({
    wallet: w,
    kind: 'BET',
    amount: '20.00',
    externalId,
    idempotencyKey: key,
  });
  record(
    '§9 idempotência',
    'replay idêntico devolve 200 sem debitar de novo',
    '200 saldo=80.00 ledger=2',
    await describe(replay, w.walletId),
  );
  record(
    '§9 idempotência',
    'replay devolve o MESMO transactionId',
    String(first.body['transactionId']),
    String(replay.body['transactionId']),
  );
  record(
    '§9 idempotência',
    'replay marca idempotentReplay',
    'true',
    String(replay.body['idempotentReplay']),
  );

  const conflict = await submit({
    wallet: w,
    kind: 'BET',
    amount: '99.00',
    externalId,
    idempotencyKey: key,
  });
  record(
    '§9 conflito',
    'mesma key com payload diferente é 409, não replay',
    '409/IDEMPOTENCY_PAYLOAD_MISMATCH saldo=80.00 ledger=2',
    await describe(conflict, w.walletId),
  );

  // §7.7: replay de uma REJECTED devolve o saldo observado NAQUELE momento.
  const rejectedId = nextId('rej');
  const rejectedKey = `${PROVIDER}:${rejectedId}`;
  const rejected = await submit({
    wallet: w,
    kind: 'BET',
    amount: '5000.00',
    externalId: rejectedId,
    idempotencyKey: rejectedKey,
  });
  const observedAtRejection = (rejected.body['balance'] as { amount: string }).amount;

  await submit({ wallet: w, kind: 'WIN', amount: '10.00' });

  const rejectedReplay = await submit({
    wallet: w,
    kind: 'BET',
    amount: '5000.00',
    externalId: rejectedId,
    idempotencyKey: rejectedKey,
  });
  record(
    '§7.7 replay fiel',
    'replay de REJECTED devolve o saldo observado na rejeição, não o atual',
    `${observedAtRejection} (saldo atual 90.00)`,
    `${String((rejectedReplay.body['balance'] as { amount: string }).amount)} (saldo atual 90.00)`,
  );
}

/** §6 — validações de domínio e contrato */
async function auditValidation(): Promise<void> {
  const w = await openWallet('100.00');

  const opening = await submit({ wallet: w, kind: 'OPENING', amount: '10.00' });
  record(
    '§6.3 OPENING interno',
    'OPENING não pode ser submetido pela API',
    '400',
    String(opening.status),
  );

  const threeDecimals = await submit({ wallet: w, kind: 'BET', amount: '1.001' });
  record(
    '§6.1 Money',
    'amount com 3 casas decimais é rejeitado',
    '400',
    String(threeDecimals.status),
  );

  const scientific = await submit({ wallet: w, kind: 'BET', amount: '1e5' });
  record('§6.1 Money', 'notação científica é rejeitada', '400', String(scientific.status));

  const negative = await submit({ wallet: w, kind: 'BET', amount: '-10.00' });
  record('§6.1 Money', 'valor negativo é rejeitado', '400', String(negative.status));

  const zero = await submit({ wallet: w, kind: 'BET', amount: '0.00' });
  record('§6.1 Money', 'valor zero é rejeitado', '400', String(zero.status));

  const currencyMismatch = await submit({
    wallet: w,
    kind: 'BET',
    amount: '10.00',
    currency: 'USD',
  });
  record(
    '§6.2 moeda',
    'moeda diferente da wallet é rejeitada',
    '422/WALLET_CURRENCY_MISMATCH',
    `${String(currencyMismatch.status)}/${String(currencyMismatch.body['failureCode'])}`,
  );

  const otherPlayer = await submit({
    wallet: w,
    kind: 'BET',
    amount: '10.00',
    playerId: crypto.randomUUID(),
  });
  record(
    '§6.2 escopo',
    'wallet que não pertence ao player é rejeitada',
    '422/PLAYER_WALLET_MISMATCH',
    `${String(otherPlayer.status)}/${String(otherPlayer.body['failureCode'])}`,
  );

  const noWallet = await submit({
    wallet: w,
    kind: 'BET',
    amount: '10.00',
    walletId: crypto.randomUUID(),
  });
  record(
    '§9 wallet inexistente',
    'wallet inexistente é 404',
    '404/WALLET_NOT_FOUND',
    `${String(noWallet.status)}/${String(noWallet.body['failureCode'])}`,
  );

  const noHeader = await post(
    '/wagering/transactions',
    bodyOf({ wallet: w, kind: 'BET', amount: '10.00' }),
  );
  record('§9 Idempotency-Key', 'header ausente é 400', '400', String(noHeader.status));

  // §6.2: uma wallet por player + moeda.
  const dup = await post('/wallets', {
    playerId: w.playerId,
    initialBalance: { amount: '10.00', currency: 'BRL' },
  });
  record(
    '§6.2 unicidade',
    'segunda wallet para o mesmo player+moeda é 409',
    '409/WALLET_ALREADY_EXISTS',
    `${String(dup.status)}/${String(dup.body['failureCode'])}`,
  );

  const usd = await post('/wallets', {
    playerId: w.playerId,
    initialBalance: { amount: '10.00', currency: 'USD' },
  });
  record('§6.1 multi-moeda', 'mesmo player em outra moeda é permitido', '201', String(usd.status));
}

/** §9 — abertura de wallet e OPENING interno */
async function auditWalletOpening(): Promise<void> {
  const w = await openWallet('1000.00');

  const rows = await orm.em
    .getConnection()
    .execute<{ kind: string; status: string; direction: string; before: string; after: string }[]>(
      `SELECT t.kind, t.status, l.direction, l.balance_before::text AS before, l.balance_after::text AS after
       FROM wager_transactions t
       JOIN wallet_ledger_entries l ON l.transaction_id = t.id
      WHERE t.wallet_id = ? AND t.kind = 'OPENING'`,
      [w.walletId],
    );
  const row = rows[0];
  record(
    '§9 abertura',
    'saldo inicial gera OPENING + lançamento CREDIT de 0 até o saldo',
    'OPENING/PROCESSED/CREDIT 0.00→1000.00',
    row
      ? `${row.kind}/${row.status}/${row.direction} ${row.before}→${row.after}`
      : 'nenhum lançamento OPENING',
  );

  const walletRes = await get(`/wallets/${w.walletId}`);
  record('§9 abertura', 'wallet nasce com version 1', '1', String(walletRes.body['version']));

  const zero = await openWallet('0.00');
  const zeroState = await stateOf(zero.walletId);
  record(
    '§9 abertura',
    'saldo inicial zero não gera OPENING nem lançamento',
    'saldo=0.00 ledger=0',
    `saldo=${zeroState.balance} ledger=${String(zeroState.entries)}`,
  );
}

/** §9 — reconciliação e consultas */
async function auditQueriesAndReconciliation(): Promise<void> {
  const w = await openWallet('500.00');
  for (let i = 0; i < 6; i++) {
    await submit({ wallet: w, kind: 'BET', amount: '10.00' });
  }

  const recon = await post(`/wallets/${w.walletId}/reconciliation`, {});
  record(
    '§9 reconciliação',
    'saldo materializado bate com o ledger',
    '200 consistent=true stored=440.00 calculated=440.00 entries=7',
    `${String(recon.status)} consistent=${String(recon.body['consistent'])} ` +
      `stored=${String((recon.body['storedBalance'] as { amount: string }).amount)} ` +
      `calculated=${String((recon.body['calculatedBalance'] as { amount: string }).amount)} ` +
      `entries=${String(recon.body['checkedEntries'])}`,
  );

  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`${API}/wallets/${w.walletId}/ledger`);
    url.searchParams.set('limit', '3');
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);
    const page = (await (await fetch(url.toString())).json()) as {
      entries: { id: string }[];
      nextCursor?: string;
    };
    for (const e of page.entries) seen.add(e.id);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== undefined && pages < 10);

  record(
    '§9 cursor',
    'percorre todas as páginas sem repetir nem pular',
    '7 lançamentos em 3 páginas',
    `${String(seen.size)} lançamentos em ${String(pages)} páginas`,
  );

  const badCursor = await get(`/wallets/${w.walletId}/ledger?cursor=invalido!!`);
  record('§9 cursor', 'cursor inválido é 400', '400', String(badCursor.status));

  const bet = await submit({ wallet: w, kind: 'BET', amount: '5.00' });
  const byId = await get(`/wagering/transactions/${String(bet.body['transactionId'])}`);
  record('§9 consulta', 'busca por id interno', '200', String(byId.status));

  const byExternal = await get(`/providers/${PROVIDER}/wagering/transactions/${bet.externalId}`);
  record(
    '§9 consulta',
    'busca por (providerId, externalTransactionId) devolve a mesma transação',
    String(bet.body['transactionId']),
    String(byExternal.body['transactionId']),
  );
}

/** §10 — o mesmo use case pela fila SQS */
async function auditSqsPath(): Promise<void> {
  const w = await openWallet('200.00');
  const queueUrl = (
    await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }))
  ).QueueUrl;
  if (queueUrl === undefined) throw new Error('fila de entrada não encontrada');

  const externalId = nextId('sqs');
  const key = `${PROVIDER}:${externalId}`;
  const messageId = nextId('msg');

  const body = JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: PROVIDER,
      externalTransactionId: externalId,
      idempotencyKey: key,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-sqs',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '45.00', currency: 'BRL' },
    },
  });

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: w.walletId,
      MessageDeduplicationId: messageId,
    }),
  );

  await waitFor(async () => ((await transactionStatus(key)) === 'PROCESSED' ? true : null), {
    what: 'BET da fila ser processada',
  });

  const afterFirst = await stateOf(w.walletId);
  record(
    '§10 SQS',
    'BET vinda da fila usa o mesmo use case e debita',
    'saldo=155.00 ledger=2',
    `saldo=${afterFirst.balance} ledger=${String(afterFirst.entries)}`,
  );

  // Dribla a dedup do broker de propósito, para provar que quem segura é o inbox.
  for (let i = 0; i < 4; i++) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: w.walletId,
        MessageDeduplicationId: `${messageId}-redelivery-${String(i)}`,
      }),
    );
  }

  await waitFor(
    async () => {
      const attrs = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      return (attrs.Messages ?? []).length === 0 ? true : null;
    },
    { what: 'reentregas serem drenadas', timeoutMs: 60_000 },
  );
  await sleep(1_500);

  const afterRedelivery = await stateOf(w.walletId);
  record(
    '§5.3 dedup persistente',
    'reentrega da mesma messageId NÃO duplica o efeito',
    'saldo=155.00 ledger=2',
    `saldo=${afterRedelivery.balance} ledger=${String(afterRedelivery.entries)}`,
  );

  const inbox = await orm.em
    .getConnection()
    .execute<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM inbox_messages WHERE message_id = ?`,
      [messageId],
    );
  record(
    '§10 inbox',
    'inbox tem exatamente 1 registro para a messageId',
    '1',
    inbox[0]?.count ?? '0',
  );
}

/** §11 — outbox e eventos */
async function auditOutbox(): Promise<void> {
  await waitFor(
    async () => {
      const rows = await orm.em
        .getConnection()
        .execute<{ count: string }[]>(
          `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
        );
      return rows[0]?.count === '0' ? true : null;
    },
    { what: 'outbox ser drenada pelo publisher', timeoutMs: 60_000 },
  );

  const rows = await orm.em
    .getConnection()
    .execute<{ event_type: string; count: string }[]>(
      `SELECT event_type, COUNT(*)::text AS count FROM outbox_messages GROUP BY event_type ORDER BY event_type`,
    );
  const present = rows.map((r) => r.event_type);
  const required = [
    'WagerTransactionPendingReference',
    'WagerTransactionProcessed',
    'WagerTransactionRejected',
    'WalletBalanceChanged',
  ];
  record(
    '§11 eventos mínimos',
    'os 4 eventos exigidos foram produzidos',
    required.join(','),
    required.filter((r) => present.includes(r)).join(','),
  );

  const unpublished = await orm.em
    .getConnection()
    .execute<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
    );
  record('§11 outbox', 'nenhum evento fica pendente', '0', unpublished[0]?.count ?? '?');

  const retried = await orm.em
    .getConnection()
    .execute<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM outbox_messages WHERE attempts > 0`,
    );
  record('§11 outbox', 'nenhum evento precisou de retry', '0', retried[0]?.count ?? '?');
}

/** §13 — invariante final sobre TODAS as wallets tocadas */
async function auditFinalInvariant(): Promise<void> {
  const broken = await orm.em
    .getConnection()
    .execute<{ id: string; stored: string; calc: string }[]>(
      `SELECT w.id, w.balance_amount::text AS stored,
            COALESCE((SELECT SUM(CASE l.direction WHEN 'CREDIT' THEN l.money_amount ELSE -l.money_amount END)
                        FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)::text AS calc
       FROM wallets w
      WHERE w.balance_amount <> COALESCE((SELECT SUM(CASE l.direction WHEN 'CREDIT' THEN l.money_amount ELSE -l.money_amount END)
                        FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)`,
    );

  const total = await orm.em
    .getConnection()
    .execute<{ count: string }[]>(`SELECT COUNT(*)::text AS count FROM wallets`);

  record(
    '§13 invariante final',
    `saldo == ledger em todas as ${String(total[0]?.count)} wallets`,
    '0 divergências',
    `${String(broken.length)} divergências`,
  );

  const unbalanced = await orm.em.getConnection().execute<{ count: string }[]>(
    `SELECT COUNT(*)::text AS count FROM (
       SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id
       HAVING SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0
     ) AS bad`,
  );
  record(
    'diferencial',
    'nenhum journal double-entry desbalanceado',
    '0',
    unbalanced[0]?.count ?? '?',
  );

  const liability = await orm.em.getConnection().execute<{ v: string }[]>(
    `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS v
       FROM journal_lines WHERE account_code = 'PLAYER_LIABILITY'`,
  );
  const walletSum = await orm.em
    .getConnection()
    .execute<{ v: string }[]>(`SELECT COALESCE(SUM(balance_amount), 0)::text AS v FROM wallets`);
  record(
    'diferencial',
    'PLAYER_LIABILITY espelha a soma dos saldos',
    String(walletSum[0]?.v),
    String(liability[0]?.v),
  );
}

async function main(): Promise<void> {
  orm = await MikroORM.init({
    ...buildMikroOrmConfig(new AppConfig(loadEnv(process.env))),
    allowGlobalContext: true,
  });

  const suites: [string, () => Promise<void>][] = [
    ['abertura de wallet', auditWalletOpening],
    ['BET', auditBet],
    ['WIN e LOSS', auditWinAndLoss],
    ['REFUND', auditRefund],
    ['ROLLBACK', auditRollback],
    ['reversão sem saldo', auditReversalInsufficientFunds],
    ['escopo da referência', auditReferenceScope],
    ['referência fora de ordem', auditOutOfOrderReference],
    ['idempotência', auditIdempotency],
    ['validações', auditValidation],
    ['consultas e reconciliação', auditQueriesAndReconciliation],
    ['caminho SQS', auditSqsPath],
    ['outbox', auditOutbox],
    ['invariante final', auditFinalInvariant],
  ];

  try {
    for (const [name, suite] of suites) {
      process.stdout.write(`  ▸ ${name}...`);
      try {
        await suite();
        process.stdout.write(' ok\n');
      } catch (error: unknown) {
        process.stdout.write(' FALHOU\n');
        record(
          'ERRO',
          name,
          'suite completa',
          `exceção: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(`\n${'═'.repeat(100)}`);
    console.log('  AUDITORIA DAS REGRAS DE NEGÓCIO');
    console.log('═'.repeat(100));

    let currentSection = '';
    for (const c of cases) {
      if (c.section !== currentSection) {
        currentSection = c.section;
        console.log(`\n  ${currentSection}`);
      }
      const mark = c.passed ? '✓' : '✗';
      console.log(`    ${mark} ${c.name}`);
      if (!c.passed) {
        console.log(`        esperado: ${c.expected}`);
        console.log(`        obtido:   ${c.actual}`);
      }
    }

    const passed = cases.filter((c) => c.passed).length;
    const failed = cases.length - passed;

    console.log(`\n${'═'.repeat(100)}`);
    console.log(
      `  ${String(passed)}/${String(cases.length)} casos corretos${failed > 0 ? ` — ${String(failed)} FALHARAM` : ''}`,
    );
    console.log(`${'═'.repeat(100)}\n`);

    if (failed > 0) process.exitCode = 1;
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error('\n  auditoria falhou:', error instanceof Error ? error.stack : error, '\n');
  process.exit(1);
});
