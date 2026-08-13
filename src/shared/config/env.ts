import { z } from 'zod';

/** String vazia vira 0 e é reprovada: melhor erro no boot do que long polling de 0s. */
const intFromEnv = (defaultValue: number): z.ZodDefault<z.ZodNumber> =>
  z.coerce.number().int().positive().default(defaultValue);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  INSTANCE_ID: z.string().min(1).default('local'),
  HTTP_PORT: intFromEnv(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PORT: intFromEnv(5432),
  POSTGRES_DB: z.string().min(1).default('wagering'),
  POSTGRES_USER: z.string().min(1).default('wagering'),
  POSTGRES_PASSWORD: z.string().min(1).default('wagering'),
  POSTGRES_POOL_MIN: intFromEnv(2),
  POSTGRES_POOL_MAX: intFromEnv(20),

  // Convertem contenção em erro retentável, em vez de deixar a requisição
  // pendurada segurando o lock da wallet.
  DB_LOCK_TIMEOUT_MS: intFromEnv(3_000),
  DB_STATEMENT_TIMEOUT_MS: intFromEnv(10_000),

  AWS_ENDPOINT_URL: z.string().url().default('http://localhost:4566'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),

  SQS_WAGER_TRANSACTIONS_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_WAGER_TRANSACTIONS_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_WAGER_EVENTS_QUEUE: z.string().min(1).default('wager-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: intFromEnv(5),
  SQS_WAIT_TIME_SECONDS: intFromEnv(20),
  SQS_MAX_MESSAGES: intFromEnv(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: intFromEnv(30),

  OUTBOX_POLL_INTERVAL_MS: intFromEnv(1_000),
  OUTBOX_BATCH_SIZE: intFromEnv(50),
  OUTBOX_LEASE_SECONDS: intFromEnv(30),
  OUTBOX_MAX_ATTEMPTS: intFromEnv(10),

  PENDING_REFERENCE_POLL_INTERVAL_MS: intFromEnv(5_000),
  PENDING_REFERENCE_MAX_ATTEMPTS: intFromEnv(8),
  PENDING_REFERENCE_BACKOFF_CAP_SECONDS: intFromEnv(60),

  QUEUE_DEPTH_POLL_INTERVAL_MS: intFromEnv(5_000),

  SHUTDOWN_GRACE_PERIOD_MS: intFromEnv(15_000),

  DEFAULT_CURRENCY: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'DEFAULT_CURRENCY deve ser um código ISO-4217 em maiúsculas')
    .default('BRL'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${issues}`);
  }

  return parsed.data;
}
