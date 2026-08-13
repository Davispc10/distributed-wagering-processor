import { spawn, type Subprocess } from 'bun';
import { TEST_ENV } from './database';
import { sleep } from './sqs';

/**
 * Processos SEPARADOS, não módulos Nest em memória: instâncias no mesmo processo
 * compartilhariam pool e event loop, e nunca exercitariam dois processos
 * disputando o mesmo lock de linha no PostgreSQL.
 */
export interface AppInstance {
  name: string;
  port: number;
  baseUrl: string;
  process: Subprocess;
  kill: (signal?: NodeJS.Signals) => void;
  waitForExit: () => Promise<number>;
}

const baseEnv = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  NODE_ENV: 'test',
  LOG_LEVEL: process.env['TEST_APP_LOG_LEVEL'] ?? 'warn',
  POSTGRES_HOST: TEST_ENV.POSTGRES_HOST,
  POSTGRES_PORT: TEST_ENV.POSTGRES_PORT,
  POSTGRES_DB: TEST_ENV.POSTGRES_DB,
  POSTGRES_USER: TEST_ENV.POSTGRES_USER,
  POSTGRES_PASSWORD: TEST_ENV.POSTGRES_PASSWORD,
  AWS_ENDPOINT_URL: TEST_ENV.AWS_ENDPOINT_URL,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
});

export async function startInstance(
  entrypoint: 'src/main-api.ts' | 'src/main-worker.ts',
  options: { name: string; port: number; env?: Record<string, string> },
): Promise<AppInstance> {
  const proc = spawn({
    cmd: ['bun', entrypoint],
    env: {
      ...baseEnv(),
      HTTP_PORT: String(options.port),
      INSTANCE_ID: options.name,
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const baseUrl = `http://localhost:${String(options.port)}`;
  await waitForHealthy(baseUrl, options.name);

  return {
    name: options.name,
    port: options.port,
    baseUrl,
    process: proc,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      proc.kill(signal);
    },
    waitForExit: async () => proc.exited,
  };
}

async function waitForHealthy(baseUrl: string, name: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await sleep(300);
  }

  throw new Error(`instância ${name} não ficou pronta em ${String(timeoutMs)}ms`);
}

export async function stopAll(instances: AppInstance[]): Promise<void> {
  for (const instance of instances) instance.kill('SIGTERM');
  await Promise.all(
    instances.map(async (instance) => Promise.race([instance.waitForExit(), sleep(20_000)])),
  );
  for (const instance of instances) {
    try {
      instance.kill('SIGKILL');
    } catch {
      // já saiu
    }
  }
}

export interface SubmitResponse {
  status: number;
  body: {
    transactionId?: string;
    status?: string;
    balance?: { amount: string; currency: string };
    idempotentReplay?: boolean;
    failureCode?: string;
    id?: string;
    version?: number;
    consistent?: boolean;
    checkedEntries?: number;
    storedBalance?: { amount: string };
    calculatedBalance?: { amount: string };
  };
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<SubmitResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as SubmitResponse['body'] };
}

export async function getJson(url: string): Promise<SubmitResponse> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as SubmitResponse['body'] };
}
