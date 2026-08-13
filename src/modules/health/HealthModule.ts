import { Module } from '@nestjs/common';
import { HEALTH_PROBES } from './application/port/HealthProbe';
import { CheckReadinessUseCase } from './application/usecase/CheckReadinessUseCase';
import { HealthController } from './infra/http/HealthController';
import { PostgresHealthProbe } from './infra/probe/PostgresHealthProbe';
import { SqsHealthProbe } from './infra/probe/SqsHealthProbe';

@Module({
  controllers: [HealthController],
  providers: [
    CheckReadinessUseCase,
    PostgresHealthProbe,
    SqsHealthProbe,
    {
      provide: HEALTH_PROBES,
      useFactory: (postgres: PostgresHealthProbe, sqs: SqsHealthProbe) => [postgres, sqs],
      inject: [PostgresHealthProbe, SqsHealthProbe],
    },
  ],
})
export class HealthModule {}
