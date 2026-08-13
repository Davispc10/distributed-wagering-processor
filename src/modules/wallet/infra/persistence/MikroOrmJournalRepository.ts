import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { JournalRepository } from '@modules/wallet/application/port/JournalRepository';
import type { Journal } from '@modules/wallet/domain/Journal';

@Injectable()
export class MikroOrmJournalRepository implements JournalRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * SQL direto em vez de EntitySchema.
   *
   * A trigger de soma zero é `CONSTRAINT ... DEFERRABLE INITIALLY DEFERRED`:
   * ela roda no fim da transação, quando todas as linhas já existem. Isso exige
   * controle da ordem dos INSERTs, que a Unit of Work do ORM não garante — ela
   * pode reordenar o flush.
   */
  async record(journal: Journal): Promise<void> {
    const tx: unknown = this.em.getTransactionContext();

    await this.em.getConnection().execute(
      `INSERT INTO journal_entries (id, transaction_id, wallet_id, description, currency)
         VALUES (?, ?, ?, ?, ?)`,
      [journal.id, journal.transactionId, journal.walletId, journal.description, journal.currency],
      'run',
      tx,
    );

    for (const line of journal.lines) {
      await this.em.getConnection().execute(
        `INSERT INTO journal_lines (id, journal_entry_id, account_code, direction, amount, currency)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [
          line.id,
          journal.id,
          line.accountCode,
          line.direction,
          line.amount.toString(),
          line.amount.currency,
        ],
        'run',
        tx,
      );
    }
  }
}
