import { InboxMessage } from '@modules/messaging/domain/InboxMessage';
import type { InboxMessageModel } from '@modules/messaging/infra/persistence/model/InboxMessageModel';

export const InboxMapper = {
  toDomain(model: InboxMessageModel): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: model.messageId,
      consumerName: model.consumerName,
      payloadHash: model.payloadHash,
      receivedAt: model.receivedAt,
      ...(model.processedAt != null ? { processedAt: model.processedAt } : {}),
    });
  },
};
