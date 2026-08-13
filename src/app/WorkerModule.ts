import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HealthModule } from '@modules/health/HealthModule';
import { KernelModule } from '@modules/kernel/KernelModule';
import { OutboxPublisherModule } from '@modules/messaging/infra/worker/OutboxPublisherModule';
import { QueueDepthModule } from '@modules/messaging/infra/worker/QueueDepthModule';
import { WageringWorkerModule } from '@modules/wagering/infra/messaging/WageringWorkerModule';
import { SharedModule } from '@shared/SharedModule';
import { AuthGuard } from '@shared/http/AuthGuard';
import { DomainExceptionFilter } from '@shared/http/DomainExceptionFilter';
import { CorrelationMiddleware } from '@shared/observability/CorrelationMiddleware';

/**
 * Sobe HTTP só para `/health/*` e `/metrics`: `outbox_lag_seconds` e
 * `sqs_dlq_messages_total` só existem neste processo.
 */
@Module({
  imports: [
    SharedModule,
    KernelModule,
    HealthModule,
    WageringWorkerModule,
    OutboxPublisherModule,
    QueueDepthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class WorkerModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
