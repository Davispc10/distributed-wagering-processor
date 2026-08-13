import pino, { type Logger as PinoLogger } from 'pino';
import { CorrelationContext } from './CorrelationContext';

/**
 * Redação estrutural: qualquer campo nesses caminhos sai como [REDACTED], mesmo
 * que alguém acrescente um `logger.info({ money })` no meio de um debug.
 */
const REDACTED_PATHS = [
  'money',
  '*.money',
  'money.amount',
  '*.money.amount',
  'balance',
  '*.balance',
  'balance.amount',
  '*.balance.amount',
  'balanceBefore',
  '*.balanceBefore',
  'balanceAfter',
  '*.balanceAfter',
  'storedBalance',
  'calculatedBalance',
  'initialBalance',
  '*.initialBalance',
  'amount',
  '*.amount',
  'payload',
  '*.payload',
  'body',
  '*.body',
  'data',
  '*.data',
  'req.headers.authorization',
  'req.headers["idempotency-key"]',
  'headers.authorization',
  'headers["idempotency-key"]',
];

export interface LoggerOptions {
  level: string;
  instanceId: string;
  service: string;
  pretty?: boolean;
  /** Existe para o teste inspecionar a saída real do pino, não a config de `redact`. */
  destination?: pino.DestinationStream;
}

export function createLogger(options: LoggerOptions): PinoLogger {
  const config: pino.LoggerOptions = {
    level: options.level,
    base: {
      service: options.service,
      instanceId: options.instanceId,
    },
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string): { level: string } => ({ level: label }),
    },
    // Injeta o contexto em toda linha, sem o call site precisar passá-lo.
    mixin: () => {
      const scope = CorrelationContext.get();
      if (!scope) return {};
      return {
        correlationId: scope.correlationId,
        ...(scope.messageId !== undefined ? { messageId: scope.messageId } : {}),
        ...(scope.transactionId !== undefined ? { transactionId: scope.transactionId } : {}),
        ...(scope.walletId !== undefined ? { walletId: scope.walletId } : {}),
        ...(scope.providerId !== undefined ? { providerId: scope.providerId } : {}),
      };
    },
    ...(options.pretty === true && options.destination === undefined
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };

  return options.destination !== undefined ? pino(config, options.destination) : pino(config);
}

export type { PinoLogger };
export { REDACTED_PATHS };
