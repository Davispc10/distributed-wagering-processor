import { Injectable, type LoggerService as NestLoggerService } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { createLogger, type PinoLogger } from './logger';

/** Faz os logs do próprio Nest saírem no mesmo formato JSON correlacionado. */
@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly root: PinoLogger;

  constructor(config: AppConfig) {
    this.root = createLogger({
      level: config.env.LOG_LEVEL,
      instanceId: config.instanceId,
      service: process.env['SERVICE_NAME'] ?? 'wagering',
    });
  }

  /** `context` recebe o nome da classe, por convenção. */
  child(context: string): PinoLogger {
    return this.root.child({ context });
  }

  get raw(): PinoLogger {
    return this.root;
  }

  log(message: unknown, context?: string): void {
    this.root.info({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.root.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.root.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.root.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.root.trace({ context }, String(message));
  }
}
