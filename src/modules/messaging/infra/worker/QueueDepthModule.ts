import { Module } from '@nestjs/common';
import { QueueDepthWorker } from './QueueDepthWorker';

/**
 * Só no `WorkerModule`: rodar nas 3 APIs multiplicaria as chamadas de
 * `GetQueueAttributes` sem acrescentar informação nenhuma.
 */
@Module({
  providers: [QueueDepthWorker],
})
export class QueueDepthModule {}
