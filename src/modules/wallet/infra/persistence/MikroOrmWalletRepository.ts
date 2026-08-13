import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money } from '@modules/kernel/domain/Money';
import { LedgerEntryMapper } from '@modules/wallet/infra/persistence/LedgerEntryMapper';
import { WalletMapper } from '@modules/wallet/infra/persistence/WalletMapper';
import {
  WalletLedgerEntryModel,
  WalletLedgerEntrySchema,
} from '@modules/wallet/infra/persistence/model/WalletLedgerEntryModel';
import { WalletModel, WalletSchema } from '@modules/wallet/infra/persistence/model/WalletModel';
import { decodeCursor, encodeCursor } from '@shared/http/Cursor';
import type {
  LedgerPage,
  LedgerQuery,
  LedgerSum,
  WalletRepository,
} from '@modules/wallet/application/port/WalletRepository';
import type { Wallet } from '@modules/wallet/domain/Wallet';
import type { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Lock de LINHA, não global: wallets diferentes seguem em paralelo. Precisa
   * ser o primeiro lock de toda transação — a ordem fixa evita deadlock cíclico.
   */
  async findByIdForUpdate(walletId: string): Promise<Wallet | null> {
    const model = await this.em.findOne(
      WalletSchema,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return model ? WalletMapper.toDomain(model) : null;
  }

  async findById(walletId: string): Promise<Wallet | null> {
    const model = await this.em.findOne(WalletSchema, { id: walletId });
    return model ? WalletMapper.toDomain(model) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const model = await this.em.findOne(WalletSchema, { playerId, currency });
    return model ? WalletMapper.toDomain(model) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    const model = WalletMapper.applyToModel(new WalletModel(), wallet);
    this.em.persist(model);
    await this.em.flush();
  }

  async update(wallet: Wallet): Promise<void> {
    const model = await this.em.findOne(WalletSchema, { id: wallet.id });
    if (!model) throw new Error(`wallet ${wallet.id} desapareceu durante a transação`);
    WalletMapper.applyToModel(model, wallet);
    await this.em.flush();
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    const model = LedgerEntryMapper.applyToModel(new WalletLedgerEntryModel(), entry);
    this.em.persist(model);
    await this.em.flush();
  }

  /**
   * Cursor em vez de OFFSET: sob escrita concorrente o OFFSET pula ou repete
   * registros, enquanto um lançamento novo nunca desloca página já lida.
   */
  async listLedger(query: LedgerQuery): Promise<LedgerPage> {
    const decoded = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;

    const where: Record<string, unknown> = { walletId: query.walletId };
    if (decoded) {
      where['$or'] = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { $lt: decoded.id } },
      ];
    }

    const models = await this.em.find(WalletLedgerEntrySchema, where, {
      orderBy: [{ createdAt: 'DESC' }, { id: 'DESC' }],
      limit: query.limit + 1,
    });

    const hasMore = models.length > query.limit;
    const page = hasMore ? models.slice(0, query.limit) : models;
    const last = page[page.length - 1];

    return {
      entries: page.map((m) => LedgerEntryMapper.toDomain(m)),
      ...(hasMore && last ? { nextCursor: encodeCursor(last.createdAt, last.id) } : {}),
    };
  }

  /** `SUM` sobre `numeric` volta string exata e não carrega o histórico inteiro. */
  async sumLedger(walletId: string, currency: string): Promise<LedgerSum> {
    const rows = await this.em
      .getConnection()
      .execute<{ total: string | null; entry_count: string }[]>(
        `SELECT
         COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN money_amount ELSE -money_amount END), 0)::text AS total,
         COUNT(*)::text AS entry_count
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
        [walletId],
      );

    const row = rows[0];
    return {
      total: Money.parse({ amount: row?.total ?? '0', currency }),
      entryCount: Number(row?.entry_count ?? '0'),
    };
  }
}
