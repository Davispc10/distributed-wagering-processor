import { Migration } from '@mikro-orm/migrations';

/**
 * Aditivo: `wallet_ledger_entries` continua sendo a fonte da verdade do saldo.
 * O journal acrescenta a contrapartida — um BET de 25 não é só "-25 na wallet",
 * é 25 saindo de PLAYER_LIABILITY e entrando em HOUSE_REVENUE.
 */
export class Migration0002DoubleEntry extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE ledger_accounts (
        code       text PRIMARY KEY,
        name       text NOT NULL,
        kind       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ledger_accounts_kind_valid CHECK (kind IN ('ASSET','LIABILITY','REVENUE','EXPENSE'))
      );
    `);

    // PLAYER_LIABILITY é passivo: o saldo do jogador é dinheiro que a casa deve.
    this.addSql(`
      INSERT INTO ledger_accounts (code, name, kind) VALUES
        ('PLAYER_LIABILITY', 'Saldo devido aos jogadores', 'LIABILITY'),
        ('HOUSE_REVENUE',    'Receita da casa',            'REVENUE'),
        ('HOUSE_PAYOUT',     'Pagamentos da casa',         'EXPENSE'),
        ('PLAYER_DEPOSITS',  'Depósitos de jogadores',     'ASSET');
    `);

    this.addSql(`
      CREATE TABLE journal_entries (
        id             uuid PRIMARY KEY,
        transaction_id uuid NOT NULL UNIQUE REFERENCES wager_transactions(id),
        wallet_id      uuid NOT NULL REFERENCES wallets(id),
        description    text NOT NULL,
        currency       char(3) NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
    `);

    this.addSql(`
      CREATE TABLE journal_lines (
        id               uuid PRIMARY KEY,
        journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_code     text NOT NULL REFERENCES ledger_accounts(code),
        direction        text NOT NULL,
        amount           numeric(20,2) NOT NULL,
        currency         char(3) NOT NULL,
        CONSTRAINT journal_lines_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT journal_lines_amount_positive CHECK (amount > 0)
      );
    `);

    this.addSql(`
      CREATE INDEX journal_lines_entry_idx ON journal_lines (journal_entry_id);
      CREATE INDEX journal_entries_wallet_idx ON journal_entries (wallet_id, created_at DESC);
    `);

    // DEFERRABLE porque as linhas entram uma a uma: verificar a cada INSERT
    // reprovaria a primeira perna de todo par válido.
    this.addSql(`
      CREATE OR REPLACE FUNCTION journal_entries_must_balance()
      RETURNS trigger AS $$
      DECLARE
        debit_total  numeric(20,2);
        credit_total numeric(20,2);
        entry_id     uuid;
      BEGIN
        entry_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

        SELECT
          COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
          COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)
          INTO debit_total, credit_total
        FROM journal_lines WHERE journal_entry_id = entry_id;

        IF debit_total <> credit_total THEN
          RAISE EXCEPTION
            'partidas dobradas desbalanceadas no journal %: débitos % != créditos %',
            entry_id, debit_total, credit_total
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE CONSTRAINT TRIGGER journal_lines_balance_check
        AFTER INSERT OR UPDATE OR DELETE ON journal_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION journal_entries_must_balance();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS journal_lines_balance_check ON journal_lines;`);
    this.addSql(`DROP TABLE IF EXISTS journal_lines;`);
    this.addSql(`DROP TABLE IF EXISTS journal_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS journal_entries_must_balance();`);
    this.addSql(`DROP TABLE IF EXISTS ledger_accounts;`);
  }
}
