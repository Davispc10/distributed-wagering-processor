import { OutboxMessage } from '@modules/messaging/domain/OutboxMessage';
import type { OutboxMessageModel } from '@modules/messaging/infra/persistence/model/OutboxMessageModel';

export const OutboxMapper = {
  toDomain(model: OutboxMessageModel): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: model.id,
      aggregateId: model.aggregateId,
      eventType: model.eventType,
      payload: model.payload,
      occurredAt: model.occurredAt,
      attempts: model.attempts,
      ...(model.nextAttemptAt != null ? { nextAttemptAt: model.nextAttemptAt } : {}),
      ...(model.publishedAt != null ? { publishedAt: model.publishedAt } : {}),
    });
  },
};
