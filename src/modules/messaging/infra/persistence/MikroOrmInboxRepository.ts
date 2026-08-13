import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type {
  InboxClaim,
  InboxRepository,
} from '@modules/messaging/application/port/MessagingPorts';
import type { InboxMessage } from '@modules/messaging/domain/InboxMessage';
import { InboxMapper } from '@modules/messaging/infra/persistence/InboxMapper';
import { InboxMessageSchema } from '@modules/messaging/infra/persistence/model/InboxMessageModel';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `ON CONFLICT DO NOTHING` decide a corrida no banco. Quem perde precisa
   * distinguir "já processada" (ack, é a duplicata esperada do at-least-once)
   * de "ainda em voo" (devolve visibilidade; se a outra falhar, a mensagem
   * volta sozinha). Cache em memória não sobreviveria a restart nem a
   * múltiplas instâncias.
   */
  async claim(message: InboxMessage): Promise<InboxClaim> {
    const inserted = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .insert({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
      })
      .onConflict(['consumerName', 'messageId'])
      .ignore()
      .returning(['messageId'])
      .execute<{ messageId: string }[]>('all');

    if (inserted.length > 0) return { outcome: 'claimed', message };

    /** `refresh` obrigatório: o vencedor da corrida é outra transação, e o
     * identity map devolveria a versão que este EM já tivesse carregado. */
    const existing = await this.em.findOne(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { refresh: true },
    );

    // Linha invisível sob READ COMMITTED: a transação vencedora ainda não commitou.
    if (!existing) return { outcome: 'in_flight' };

    const persisted = InboxMapper.toDomain(existing);

    return persisted.isProcessed()
      ? { outcome: 'already_processed', message: persisted }
      : { outcome: 'in_flight' };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
