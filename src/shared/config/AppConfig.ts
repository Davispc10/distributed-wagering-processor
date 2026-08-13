import { Inject, Injectable, Optional } from '@nestjs/common';
import { loadEnv, type Env } from './env';

/** Sobrescreve o ambiente em teste sem tocar em variável global do processo. */
export const ENV_OVERRIDE = Symbol('ENV_OVERRIDE');

@Injectable()
export class AppConfig {
  readonly env: Env;

  constructor(@Optional() @Inject(ENV_OVERRIDE) env?: Env) {
    this.env = env ?? loadEnv();
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get instanceId(): string {
    return this.env.INSTANCE_ID;
  }

  get httpPort(): number {
    return this.env.HTTP_PORT;
  }

  get defaultCurrency(): string {
    return this.env.DEFAULT_CURRENCY;
  }

  get postgres(): {
    host: string;
    port: number;
    dbName: string;
    user: string;
    password: string;
    poolMin: number;
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  } {
    const e = this.env;
    return {
      host: e.POSTGRES_HOST,
      port: e.POSTGRES_PORT,
      dbName: e.POSTGRES_DB,
      user: e.POSTGRES_USER,
      password: e.POSTGRES_PASSWORD,
      poolMin: e.POSTGRES_POOL_MIN,
      poolMax: e.POSTGRES_POOL_MAX,
      lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    };
  }

  get aws(): {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  } {
    const e = this.env;
    return {
      endpoint: e.AWS_ENDPOINT_URL,
      region: e.AWS_REGION,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
    };
  }

  get queues(): {
    wagerTransactions: string;
    wagerTransactionsDlq: string;
    wagerEvents: string;
    maxReceiveCount: number;
    waitTimeSeconds: number;
    maxMessages: number;
    visibilityTimeoutSeconds: number;
  } {
    const e = this.env;
    return {
      wagerTransactions: e.SQS_WAGER_TRANSACTIONS_QUEUE,
      wagerTransactionsDlq: e.SQS_WAGER_TRANSACTIONS_DLQ,
      wagerEvents: e.SQS_WAGER_EVENTS_QUEUE,
      maxReceiveCount: e.SQS_MAX_RECEIVE_COUNT,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      maxMessages: e.SQS_MAX_MESSAGES,
      visibilityTimeoutSeconds: e.SQS_VISIBILITY_TIMEOUT_SECONDS,
    };
  }

  get outbox(): {
    pollIntervalMs: number;
    batchSize: number;
    leaseSeconds: number;
    maxAttempts: number;
  } {
    const e = this.env;
    return {
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseSeconds: e.OUTBOX_LEASE_SECONDS,
      maxAttempts: e.OUTBOX_MAX_ATTEMPTS,
    };
  }

  get pendingReference(): {
    pollIntervalMs: number;
    maxAttempts: number;
    backoffCapSeconds: number;
  } {
    const e = this.env;
    return {
      pollIntervalMs: e.PENDING_REFERENCE_POLL_INTERVAL_MS,
      maxAttempts: e.PENDING_REFERENCE_MAX_ATTEMPTS,
      backoffCapSeconds: e.PENDING_REFERENCE_BACKOFF_CAP_SECONDS,
    };
  }

  get queueDepth(): { pollIntervalMs: number } {
    return { pollIntervalMs: this.env.QUEUE_DEPTH_POLL_INTERVAL_MS };
  }

  get shutdownGracePeriodMs(): number {
    return this.env.SHUTDOWN_GRACE_PERIOD_MS;
  }
}
