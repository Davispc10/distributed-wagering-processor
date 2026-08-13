import { Migration } from '@mikro-orm/migrations';

/**
 * Escrito à mão: schema diff não produz CHECK aritmético, índice único parcial
 * nem trigger de imutabilidade. Cada constraint tem um teste que prova que ela
 * rejeita a violação.
 */
export class Migration0001Init extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid PRIMARY KEY,
        player_id       uuid NOT NULL,
        currency        char(3) NOT NULL,
        balance_amount  numeric(20,2) NOT NULL,
        version         integer NOT NULL DEFAULT 1,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),

        -- Rede final: saldo negativo impossível mesmo com bug de aplicação.
        CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_currency_iso4217     CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wallets_player_currency_uk ON wallets (player_id, currency);
    `);

    // ------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL,
        external_transaction_id           text NOT NULL,
        idempotency_key                   text NOT NULL,
        payload_hash                      char(64) NOT NULL,
        wallet_id                         uuid NOT NULL REFERENCES wallets(id),
        player_id                         uuid NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL,
        money_amount                      numeric(20,2) NOT NULL,
        money_currency                    char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid REFERENCES wager_transactions(id),
        status                            text NOT NULL,
        failure_code                      text,
        observed_balance_amount           numeric(20,2),
        observed_balance_currency         char(3),
        reference_attempts                integer NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        created_at                        timestamptz NOT NULL DEFAULT now(),
        processed_at                      timestamptz,

        CONSTRAINT wager_transactions_kind_valid
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_transactions_money_positive
          CHECK (money_amount > 0),

        -- REFUND e ROLLBACK exigem referência.
        CONSTRAINT wager_transactions_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),

        CONSTRAINT wager_transactions_terminal_has_processed_at
          CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR processed_at IS NOT NULL),

        -- Sem failureCode, o provedor teria que adivinhar o motivo.
        CONSTRAINT wager_transactions_rejected_has_failure_code
          CHECK (status <> 'REJECTED' OR failure_code IS NOT NULL),

        CONSTRAINT wager_transactions_observed_balance_pair
          CHECK (
            (observed_balance_amount IS NULL AND observed_balance_currency IS NULL)
            OR (observed_balance_amount IS NOT NULL AND observed_balance_currency IS NOT NULL)
          ),

        CONSTRAINT wager_transactions_reference_attempts_non_negative
          CHECK (reference_attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_idempotency_key_uk
        ON wager_transactions (idempotency_key);
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_provider_external_uk
        ON wager_transactions (provider_id, external_transaction_id);
    `);

    // Uma referência não é revertida duas vezes pelo mesmo tipo. Parcial de
    // propósito: uma tentativa REJECTED não bloqueia a reversão legítima seguinte.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal_uk
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_reference_lookup_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE reference_external_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_wallet_idx ON wager_transactions (wallet_id, created_at DESC);
    `);

    // -------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid PRIMARY KEY,
        wallet_id      uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction      text NOT NULL,
        money_amount   numeric(20,2) NOT NULL,
        money_currency char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after  numeric(20,2) NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_money_positive  CHECK (money_amount > 0),
        CONSTRAINT ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT ledger_balance_before_non_negative CHECK (balance_before >= 0),

        -- Sem este CHECK, um bug de mapeamento produziria ledger que não
        -- reconcilia, e a divergência só apareceria muito depois.
        CONSTRAINT ledger_arithmetic CHECK (
          balance_after = balance_before +
            CASE direction WHEN 'CREDIT' THEN money_amount ELSE -money_amount END
        )
      );
    `);

    // Um lançamento por wallet por transação: é esta constraint que torna o
    // débito duplicado impossível mesmo com dois processos simultâneos.
    this.addSql(`
      CREATE UNIQUE INDEX ledger_transaction_wallet_uk
        ON wallet_ledger_entries (transaction_id, wallet_id);
    `);

    this.addSql(`
      CREATE INDEX ledger_wallet_cursor_idx
        ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    // Convenção de código não impede um UPDATE ad-hoc em produção; a trigger sim.
    this.addSql(`
      CREATE OR REPLACE FUNCTION wallet_ledger_entries_immutable()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'wallet_ledger_entries é append-only: % não é permitido (lançamento %)',
          TG_OP, COALESCE(OLD.id::text, '?')
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_immutable();
    `);

    // --------------------------------------------------------- inbox_messages
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  char(64) NOT NULL,
        received_at   timestamptz NOT NULL DEFAULT now(),
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE INDEX inbox_messages_unprocessed_idx
        ON inbox_messages (received_at)
        WHERE processed_at IS NULL;
    `);

    // -------------------------------------------------------- outbox_messages
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    uuid NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        locked_by       text,
        locked_until    timestamptz,

        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);

    // Parcial em published_at IS NULL para o índice não crescer com o histórico.
    this.addSql(`
      CREATE INDEX outbox_messages_claim_idx
        ON outbox_messages (next_attempt_at NULLS FIRST, occurred_at)
        WHERE published_at IS NULL;
    `);

    this.addSql(`
      CREATE INDEX outbox_messages_lag_idx
        ON outbox_messages (occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(
      `DROP TRIGGER IF EXISTS wallet_ledger_entries_no_update_delete ON wallet_ledger_entries;`,
    );
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_entries_immutable();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
