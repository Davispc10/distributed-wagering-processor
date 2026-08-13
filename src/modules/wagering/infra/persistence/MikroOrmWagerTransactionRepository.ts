import { EntityManager, LockMode, QueryOrder } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { WagerTransactionMapper } from '@modules/wagering/infra/persistence/WagerTransactionMapper';
import {
  WagerTransactionModel,
  WagerTransactionSchema,
} from '@modules/wagering/infra/persistence/model/WagerTransactionModel';
import type { WagerTransactionRepository } from '@modules/wagering/application/port/WagerTransactionRepository';
import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const model = await this.em.findOne(WagerTransactionSchema, { idempotencyKey });
    return model ? WagerTransactionMapper.toDomain(model) : null;
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const model = await this.em.findOne(WagerTransactionSchema, { id });
    return model ? WagerTransactionMapper.toDomain(model) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const model = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return model ? WagerTransactionMapper.toDomain(model) : null;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    const model = WagerTransactionMapper.applyToModel(new WagerTransactionModel(), transaction);
    this.em.persist(model);
    await this.em.flush();
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const model = await this.em.findOne(WagerTransactionSchema, { id: transaction.id });
    if (!model) throw new Error(`transação ${transaction.id} não encontrada para atualização`);
    WagerTransactionMapper.applyToModel(model, transaction);
    await this.em.flush();
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  /**
   * `PESSIMISTIC_PARTIAL_WRITE` é `FOR UPDATE SKIP LOCKED`: N workers pegam
   * lotes disjuntos em vez de disputar linhas. `NULLS FIRST` é obrigatório —
   * quem nunca tentou tem prioridade sobre quem está em backoff.
   */
  async claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const models = await this.em.find(
      WagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: [{ nextAttemptAt: QueryOrder.ASC_NULLS_FIRST }, { createdAt: QueryOrder.ASC }],
        limit,
      },
    );

    return models.map((m) => WagerTransactionMapper.toDomain(m));
  }
}
