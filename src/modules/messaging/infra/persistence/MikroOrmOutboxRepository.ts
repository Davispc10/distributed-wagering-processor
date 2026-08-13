import { EntityManager, QueryOrder } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { IntegrationEvent } from '@modules/kernel/domain/event/IntegrationEvent';
import { OutboxMapper } from '@modules/messaging/infra/persistence/OutboxMapper';
import {
  OutboxMessageModel,
  OutboxMessageSchema,
} from '@modules/messaging/infra/persistence/model/OutboxMessageModel';
import type { OutboxRepository } from '@modules/messaging/application/port/MessagingPorts';
import { OutboxMessage } from '@modules/messaging/domain/OutboxMessage';

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Grava na MESMA transação da mudança financeira. É o que torna impossível
   * publicar antes do commit: aqui o evento só vira linha de tabela.
   */
  async enqueue(events: IntegrationEvent<unknown>[]): Promise<void> {
    if (events.length === 0) return;

    for (const event of events) {
      const domain = OutboxMessage.enqueue(event);
      const model = new OutboxMessageModel();
      model.id = domain.id;
      model.aggregateId = domain.aggregateId;
      model.eventType = domain.eventType;
      model.payload = domain.payload;
      model.occurredAt = domain.occurredAt;
      model.attempts = domain.attempts;
      model.nextAttemptAt = null;
      model.publishedAt = null;
      model.lockedBy = null;
      model.lockedUntil = null;
      this.em.persist(model);
    }

    await this.em.flush();
  }

  /**
   * `SKIP LOCKED` faz dois publishers pegarem lotes disjuntos em vez de um
   * esperar o outro. O lease cobre o worker que morre com o lote na mão.
   */
  async claimBatch(
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
    now: Date,
  ): Promise<OutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);

    const rows = await this.em.getConnection().execute<{ id: string }[]>(
      `UPDATE outbox_messages
          SET locked_by = ?, locked_until = ?
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY next_attempt_at NULLS FIRST, occurred_at
           FOR UPDATE SKIP LOCKED
           LIMIT ?
        )
        RETURNING id`,
      [workerId, leaseUntil, now, now, batchSize],
      'all',
      this.em.getTransactionContext(),
    );

    if (rows.length === 0) return [];

    const models = await this.em.find(OutboxMessageSchema, { id: { $in: rows.map((r) => r.id) } });
    // Eventos da mesma wallet precisam sair na ordem do claim.
    const byId = new Map(models.map((m) => [m.id, m]));
    return rows
      .map((r) => byId.get(r.id))
      .filter((m): m is OutboxMessageModel => m !== undefined)
      .map((m) => OutboxMapper.toDomain(m));
  }

  async markPublished(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;

    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: { $in: ids } },
      { publishedAt: at, lockedBy: null, lockedUntil: null },
    );
  }

  async scheduleRetry(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        lockedBy: null,
        lockedUntil: null,
      },
    );
  }

  async oldestPendingLagSeconds(now: Date): Promise<number> {
    const oldest = await this.em.findOne(
      OutboxMessageSchema,
      { publishedAt: null },
      { orderBy: { occurredAt: QueryOrder.ASC }, fields: ['occurredAt'] },
    );
    if (!oldest) return 0;
    return Math.max(0, (now.getTime() - oldest.occurredAt.getTime()) / 1000);
  }

  async countPending(): Promise<number> {
    return this.em.count(OutboxMessageSchema, { publishedAt: null });
  }
}
