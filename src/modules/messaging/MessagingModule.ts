import { Module } from '@nestjs/common';
import { INBOX_REPOSITORY, OUTBOX_REPOSITORY } from './application/port/MessagingPorts';
import { MikroOrmInboxRepository } from './infra/persistence/MikroOrmInboxRepository';
import { MikroOrmOutboxRepository } from './infra/persistence/MikroOrmOutboxRepository';

/** Só persistência: a API escreve na outbox, mas quem publica é o worker. */
@Module({
  providers: [
    { provide: INBOX_REPOSITORY, useClass: MikroOrmInboxRepository },
    { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
  ],
  exports: [INBOX_REPOSITORY, OUTBOX_REPOSITORY],
})
export class MessagingModule {}
