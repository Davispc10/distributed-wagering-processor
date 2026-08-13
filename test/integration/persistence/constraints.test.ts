import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { closeOrm, getOrm, truncateAll, uuid } from '@test/support/database';

/**
 * A seção 5.9 exige que as garantias vivam no SCHEMA, não só em código.
 *
 * Cada teste aqui prova que o **banco** rejeita a violação — não a aplicação.
 * Constraint sem teste é constraint que não existe: ela some num refactor de
 * migration e ninguém percebe até o dia em que ela seria necessária.
 */

let orm: MikroORM;

const exec = async (sql: string, params: unknown[] = []): Promise<unknown> =>
  orm.em.getConnection().execute(sql, params);

const expectRejection = async (sql: string, params: unknown[] = []): Promise<string> => {
  try {
    await exec(sql, params);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`o banco ACEITOU o que deveria rejeitar: ${sql.slice(0, 120)}`);
};

const insertWallet = async (
  id: string,
  playerId: string,
  balance = '100.00',
  currency = 'BRL',
): Promise<void> => {
  await exec(
    `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
     VALUES (?, ?, ?, ?, 1)`,
    [id, playerId, currency, balance],
  );
};

const insertTransaction = async (
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> => {
  const id = (overrides['id'] as string | undefined) ?? uuid();
  const values = {
    id,
    provider_id: 'provider-a',
    external_transaction_id: `ext-${id}`,
    idempotency_key: `provider-a:ext-${id}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: overrides['wallet_id'],
    player_id: overrides['player_id'],
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    money_amount: '25.00',
    money_currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    processed_at: new Date(),
    ...overrides,
  };

  const keys = Object.keys(values);
  await exec(
    `INSERT INTO wager_transactions (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => values[k as keyof typeof values]),
  );
  return id;
};

beforeEach(async () => {
  orm = await getOrm();
  await truncateAll(orm);
});

afterAll(async () => {
  await closeOrm();
});

describe('wallets — constraints no schema', () => {
  it('rejeita saldo negativo', async () => {
    const message = await expectRejection(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', '-0.01', 1)`,
      [uuid(), uuid()],
    );
    expect(message).toContain('wallets_balance_non_negative');
  });

  it('rejeita UPDATE que tornaria o saldo negativo — a rede final da concorrência', async () => {
    const walletId = uuid();
    await insertWallet(walletId, uuid(), '10.00');

    const message = await expectRejection(
      `UPDATE wallets SET balance_amount = '-1.00' WHERE id = ?`,
      [walletId],
    );
    expect(message).toContain('wallets_balance_non_negative');
  });

  it('rejeita segunda wallet para o mesmo player + moeda', async () => {
    const playerId = uuid();
    await insertWallet(uuid(), playerId, '10.00', 'BRL');

    const message = await expectRejection(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', '10.00', 1)`,
      [uuid(), playerId],
    );
    expect(message).toContain('wallets_player_currency_uk');
  });

  it('PERMITE wallets do mesmo player em moedas diferentes', async () => {
    const playerId = uuid();
    await insertWallet(uuid(), playerId, '10.00', 'BRL');
    await insertWallet(uuid(), playerId, '10.00', 'USD');
    // sem exceção — o modelo continua multi-moeda
  });

  it('rejeita version menor que 1', async () => {
    const message = await expectRejection(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', '10.00', 0)`,
      [uuid(), uuid()],
    );
    expect(message).toContain('wallets_version_positive');
  });

  it('rejeita currency fora do padrão ISO-4217', async () => {
    const message = await expectRejection(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'br1', '10.00', 1)`,
      [uuid(), uuid()],
    );
    expect(message).toContain('wallets_currency_iso4217');
  });
});

describe('wager_transactions — constraints no schema', () => {
  let walletId: string;
  let playerId: string;

  beforeEach(async () => {
    walletId = uuid();
    playerId = uuid();
    await insertWallet(walletId, playerId);
  });

  it('rejeita idempotency_key duplicada — idempotência é do banco, não de cache', async () => {
    await insertTransaction({
      wallet_id: walletId,
      player_id: playerId,
      idempotency_key: 'provider-a:dup',
    });

    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
         status, processed_at)
       VALUES (?, 'provider-b', 'outro-ext', 'provider-a:dup', ?, ?, ?, 'r', 'g', 'BET', '1.00', 'BRL', 'PROCESSED', now())`,
      [uuid(), 'b'.repeat(64), walletId, playerId],
    );
    expect(message).toContain('wager_transactions_idempotency_key_uk');
  });

  it('rejeita (provider, externalTransactionId) duplicado', async () => {
    await insertTransaction({
      wallet_id: walletId,
      player_id: playerId,
      external_transaction_id: 'ext-fixo',
    });

    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
         status, processed_at)
       VALUES (?, 'provider-a', 'ext-fixo', 'chave-diferente', ?, ?, ?, 'r', 'g', 'BET', '1.00', 'BRL', 'PROCESSED', now())`,
      [uuid(), 'c'.repeat(64), walletId, playerId],
    );
    expect(message).toContain('wager_transactions_provider_external_uk');
  });

  it('rejeita valor não positivo', async () => {
    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
         status, processed_at)
       VALUES (?, 'p', 'e', 'k', ?, ?, ?, 'r', 'g', 'BET', '0.00', 'BRL', 'PROCESSED', now())`,
      [uuid(), 'd'.repeat(64), walletId, playerId],
    );
    expect(message).toContain('wager_transactions_money_positive');
  });

  it.each(['REFUND', 'ROLLBACK'])('rejeita %s sem referência', async (kind) => {
    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
         status, processed_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', ?, '1.00', 'BRL', 'PROCESSED', now())`,
      [uuid(), `e-${kind}`, `k-${kind}`, 'e'.repeat(64), walletId, playerId, kind],
    );
    expect(message).toContain('wager_transactions_reference_required');
  });

  it('rejeita status terminal sem processed_at', async () => {
    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status)
       VALUES (?, 'p', 'e2', 'k2', ?, ?, ?, 'r', 'g', 'BET', '1.00', 'BRL', 'PROCESSED')`,
      [uuid(), 'f'.repeat(64), walletId, playerId],
    );
    expect(message).toContain('wager_transactions_terminal_has_processed_at');
  });

  it('rejeita REJECTED sem failure_code — o provedor precisa saber o motivo', async () => {
    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
         status, processed_at)
       VALUES (?, 'p', 'e3', 'k3', ?, ?, ?, 'r', 'g', 'BET', '1.00', 'BRL', 'REJECTED', now())`,
      [uuid(), 'g'.repeat(64), walletId, playerId],
    );
    expect(message).toContain('wager_transactions_rejected_has_failure_code');
  });

  it('rejeita kind desconhecido', async () => {
    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
         status, processed_at)
       VALUES (?, 'p', 'e4', 'k4', ?, ?, ?, 'r', 'g', 'JACKPOT', '1.00', 'BRL', 'PROCESSED', now())`,
      [uuid(), 'h'.repeat(64), walletId, playerId],
    );
    expect(message).toContain('wager_transactions_kind_valid');
  });

  it('rejeita observed_balance com valor sem moeda', async () => {
    const message = await expectRejection(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
         status, processed_at, observed_balance_amount)
       VALUES (?, 'p', 'e5', 'k5', ?, ?, ?, 'r', 'g', 'BET', '1.00', 'BRL', 'PROCESSED', now(), '10.00')`,
      [uuid(), 'i'.repeat(64), walletId, playerId],
    );
    expect(message).toContain('wager_transactions_observed_balance_pair');
  });

  describe('dupla reversão', () => {
    it('rejeita segundo REFUND PROCESSED da mesma BET', async () => {
      const betId = await insertTransaction({ wallet_id: walletId, player_id: playerId });

      await insertTransaction({
        wallet_id: walletId,
        player_id: playerId,
        kind: 'REFUND',
        reference_external_transaction_id: 'ext-bet',
        reference_transaction_id: betId,
      });

      const message = await expectRejection(
        `INSERT INTO wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
           reference_external_transaction_id, reference_transaction_id, status, processed_at)
         VALUES (?, 'p', 'ext-refund-2', 'k-refund-2', ?, ?, ?, 'r', 'g', 'REFUND', '1.00', 'BRL',
                 'ext-bet', ?, 'PROCESSED', now())`,
        [uuid(), 'j'.repeat(64), walletId, playerId, betId],
      );
      expect(message).toContain('wager_transactions_single_reversal_uk');
    });

    it('PERMITE um REFUND e um ROLLBACK da mesma referência — tipos diferentes', async () => {
      const betId = await insertTransaction({ wallet_id: walletId, player_id: playerId });

      await insertTransaction({
        wallet_id: walletId,
        player_id: playerId,
        kind: 'REFUND',
        reference_external_transaction_id: 'ext-bet',
        reference_transaction_id: betId,
      });
      await insertTransaction({
        wallet_id: walletId,
        player_id: playerId,
        kind: 'ROLLBACK',
        reference_external_transaction_id: 'ext-bet',
        reference_transaction_id: betId,
      });
      // sem exceção — o índice é por (referência, kind)
    });

    it('PERMITE nova reversão depois de uma REJECTED — o índice é parcial', async () => {
      const betId = await insertTransaction({ wallet_id: walletId, player_id: playerId });

      await insertTransaction({
        wallet_id: walletId,
        player_id: playerId,
        kind: 'REFUND',
        reference_external_transaction_id: 'ext-bet',
        reference_transaction_id: betId,
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
      });

      await insertTransaction({
        wallet_id: walletId,
        player_id: playerId,
        kind: 'REFUND',
        reference_external_transaction_id: 'ext-bet',
        reference_transaction_id: betId,
        status: 'PROCESSED',
      });
      // sem exceção — uma tentativa rejeitada não bloqueia a reversão legítima
    });
  });
});

describe('wallet_ledger_entries — constraints e imutabilidade', () => {
  let walletId: string;
  let playerId: string;
  let transactionId: string;

  beforeEach(async () => {
    walletId = uuid();
    playerId = uuid();
    await insertWallet(walletId, playerId);
    transactionId = await insertTransaction({ wallet_id: walletId, player_id: playerId });
  });

  const insertEntry = async (overrides: Partial<Record<string, unknown>> = {}): Promise<string> => {
    const id = (overrides['id'] as string | undefined) ?? uuid();
    const values = {
      id,
      wallet_id: walletId,
      transaction_id: transactionId,
      direction: 'DEBIT',
      money_amount: '25.00',
      money_currency: 'BRL',
      balance_before: '100.00',
      balance_after: '75.00',
      ...overrides,
    };
    const keys = Object.keys(values);
    await exec(
      `INSERT INTO wallet_ledger_entries (${keys.join(', ')})
       VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((k) => values[k as keyof typeof values]),
    );
    return id;
  };

  it('rejeita aritmética inconsistente — o banco confere o lançamento', async () => {
    const message = await expectRejection(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after)
       VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '80.00')`,
      [uuid(), walletId, transactionId],
    );
    expect(message).toContain('ledger_arithmetic');
  });

  it('rejeita CREDIT lançado com saldo de DEBIT', async () => {
    const message = await expectRejection(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after)
       VALUES (?, ?, ?, 'CREDIT', '25.00', 'BRL', '100.00', '75.00')`,
      [uuid(), walletId, transactionId],
    );
    expect(message).toContain('ledger_arithmetic');
  });

  it('rejeita balance_after negativo', async () => {
    const message = await expectRejection(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after)
       VALUES (?, ?, ?, 'DEBIT', '150.00', 'BRL', '100.00', '-50.00')`,
      [uuid(), walletId, transactionId],
    );
    expect(message).toContain('ledger_balance_after_non_negative');
  });

  it('rejeita SEGUNDO lançamento da mesma transação na mesma wallet', async () => {
    await insertEntry();

    const message = await expectRejection(
      `INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after)
       VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '75.00', '50.00')`,
      [uuid(), walletId, transactionId],
    );
    // Esta é a constraint que torna o débito duplicado impossível mesmo se dois
    // processos passarem pela mesma transação ao mesmo tempo.
    expect(message).toContain('ledger_transaction_wallet_uk');
  });

  it('rejeita UPDATE — imutabilidade estrutural', async () => {
    const entryId = await insertEntry();

    const message = await expectRejection(
      `UPDATE wallet_ledger_entries SET money_amount = '999.00' WHERE id = ?`,
      [entryId],
    );
    expect(message).toContain('append-only');
    expect(message).toContain('UPDATE');
  });

  it('rejeita DELETE — imutabilidade estrutural', async () => {
    const entryId = await insertEntry();

    const message = await expectRejection(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [
      entryId,
    ]);
    expect(message).toContain('append-only');
    expect(message).toContain('DELETE');
  });

  it('o lançamento permanece intacto após tentativa de adulteração', async () => {
    const entryId = await insertEntry();
    await expectRejection(`UPDATE wallet_ledger_entries SET money_amount = '999.00' WHERE id = ?`, [
      entryId,
    ]);

    const rows = await orm.em
      .getConnection()
      .execute<{ money_amount: string }[]>(
        `SELECT money_amount::text FROM wallet_ledger_entries WHERE id = ?`,
        [entryId],
      );
    expect(rows[0]?.money_amount).toBe('25.00');
  });
});

describe('inbox_messages — dedup persistente', () => {
  it('rejeita (consumer, messageId) duplicado', async () => {
    await exec(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES (?, ?, ?)`,
      ['wager-consumer', 'msg-1', 'k'.repeat(64)],
    );

    const message = await expectRejection(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES (?, ?, ?)`,
      ['wager-consumer', 'msg-1', 'l'.repeat(64)],
    );
    expect(message).toContain('inbox_messages_pkey');
  });

  it('PERMITE o mesmo messageId em consumidores diferentes', async () => {
    await exec(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES (?, ?, ?)`,
      ['consumer-a', 'msg-1', 'm'.repeat(64)],
    );
    await exec(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES (?, ?, ?)`,
      ['consumer-b', 'msg-1', 'm'.repeat(64)],
    );
  });
});

describe('numeric chega como string — Money nunca passa por number', () => {
  it('balance_amount é string no driver', async () => {
    const walletId = uuid();
    await insertWallet(walletId, uuid(), '1234567890.99');

    const rows = await orm.em
      .getConnection()
      .execute<{ balance_amount: unknown }[]>(`SELECT balance_amount FROM wallets WHERE id = ?`, [
        walletId,
      ]);

    expect(typeof rows[0]?.balance_amount).toBe('string');
    expect(rows[0]?.balance_amount).toBe('1234567890.99');
  });
});
