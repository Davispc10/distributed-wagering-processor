import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, Type } from '@nestjs/common';
import { AppConfig } from './shared/config/AppConfig';
import { LoggerService } from './shared/observability/LoggerService';

export interface BootstrapOptions {
  module: Type<unknown>;
  serviceName: string;
}

/**
 * `enableShutdownHooks` é o que faz SIGTERM chegar aos `OnApplicationShutdown`.
 * Sem isso o consumidor SQS morreria no meio de uma mensagem em voo.
 */
export async function bootstrap(options: BootstrapOptions): Promise<INestApplication> {
  process.env['SERVICE_NAME'] = options.serviceName;

  const app = await NestFactory.create(options.module, { bufferLogs: true });

  const logger = app.get(LoggerService);
  const config = app.get(AppConfig);
  app.useLogger(logger);
  app.enableShutdownHooks();

  await app.listen(config.httpPort);

  logger.raw.info(
    { context: 'bootstrap', port: config.httpPort, nodeEnv: config.env.NODE_ENV },
    `${options.serviceName} iniciado`,
  );

  const shutdown = (signal: string): void => {
    logger.raw.info({ context: 'bootstrap', signal }, 'shutdown iniciado');
    void app.close().then(
      () => {
        logger.raw.info({ context: 'bootstrap' }, 'shutdown concluído');
        process.exit(0);
      },
      (error: unknown) => {
        logger.raw.error(
          { context: 'bootstrap', err: error instanceof Error ? error.message : String(error) },
          'shutdown falhou',
        );
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  return app;
}
