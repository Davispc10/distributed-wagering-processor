import { Global, Module } from '@nestjs/common';
import { ConfigModule } from './config/ConfigModule';
import { SqsClientProvider } from './messaging/SqsClientProvider';
import { LoggerService } from './observability/LoggerService';
import { MetricsService } from './observability/MetricsService';
import { PersistenceModule } from './persistence/PersistenceModule';

@Global()
@Module({
  imports: [ConfigModule, PersistenceModule],
  providers: [LoggerService, MetricsService, SqsClientProvider],
  exports: [ConfigModule, LoggerService, MetricsService, SqsClientProvider],
})
export class SharedModule {}
