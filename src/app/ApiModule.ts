import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HealthModule } from '@modules/health/HealthModule';
import { KernelModule } from '@modules/kernel/KernelModule';
import { WageringHttpModule } from '@modules/wagering/infra/http/WageringHttpModule';
import { WalletHttpModule } from '@modules/wallet/infra/http/WalletHttpModule';
import { SharedModule } from '@shared/SharedModule';
import { AuthGuard } from '@shared/http/AuthGuard';
import { DomainExceptionFilter } from '@shared/http/DomainExceptionFilter';
import { CorrelationMiddleware } from '@shared/observability/CorrelationMiddleware';

/**
 * Não importa consumidor de SQS nem worker de propósito: se importasse, escalar
 * a API para absorver tráfego HTTP multiplicaria também os consumidores da fila.
 */
@Module({
  imports: [SharedModule, KernelModule, HealthModule, WalletHttpModule, WageringHttpModule],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
