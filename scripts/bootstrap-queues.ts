/**
 * Cria as filas FIFO e a redrive policy, e VALIDA os atributos de volta — se o
 * emulador não honrar a configuração, o erro aparece no boot em vez de um teste
 * de concorrência falhando de forma obscura depois.
 *
 * Idempotente: o compose roda a cada `up`.
 *
 * Uso: bun run queues:bootstrap
 */
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const region = process.env.AWS_REGION ?? 'us-east-1';

const MAIN_QUEUE = process.env.SQS_WAGER_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo';
const DLQ = process.env.SQS_WAGER_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo';
const EVENTS_QUEUE = process.env.SQS_WAGER_EVENTS_QUEUE ?? 'wager-events.fifo';
const MAX_RECEIVE_COUNT = process.env.SQS_MAX_RECEIVE_COUNT ?? '5';
const VISIBILITY_TIMEOUT = process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? '30';

const sqs = new SQSClient({
  endpoint,
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

const FIFO_ATTRS: Record<string, string> = {
  FifoQueue: 'true',
  // Dedup do broker é otimização. A garantia real é o inbox persistente.
  ContentBasedDeduplication: 'false',
  VisibilityTimeout: VISIBILITY_TIMEOUT,
  MessageRetentionPeriod: '345600',
};

async function ensureQueue(name: string, extra: Record<string, string> = {}): Promise<string> {
  try {
    const existing = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (existing.QueueUrl) {
      if (Object.keys(extra).length > 0) {
        await sqs.send(
          new SetQueueAttributesCommand({ QueueUrl: existing.QueueUrl, Attributes: extra }),
        );
      }
      console.log(`  = ${name} (já existia)`);
      return existing.QueueUrl;
    }
  } catch {
    // não existe — segue para criar
  }

  const created = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { ...FIFO_ATTRS, ...extra } }),
  );
  if (!created.QueueUrl) throw new Error(`falha ao criar a fila ${name}`);
  console.log(`  + ${name}`);
  return created.QueueUrl;
}

async function getAttributes(queueUrl: string): Promise<Record<string, string>> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
  );
  return res.Attributes ?? {};
}

async function waitForEndpoint(attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${endpoint}/_ministack/health`);
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`endpoint SQS não respondeu em ${endpoint} após ${attempts}s`);
}

async function main(): Promise<void> {
  console.log(`\n  Bootstrap de filas em ${endpoint}\n`);
  await waitForEndpoint();

  const dlqUrl = await ensureQueue(DLQ);
  const dlqAttrs = await getAttributes(dlqUrl);
  const dlqArn = dlqAttrs['QueueArn'];
  if (!dlqArn) throw new Error(`não foi possível resolver o ARN da DLQ ${DLQ}`);

  const redrivePolicy = JSON.stringify({
    deadLetterTargetArn: dlqArn,
    maxReceiveCount: Number(MAX_RECEIVE_COUNT),
  });

  const mainUrl = await ensureQueue(MAIN_QUEUE, { RedrivePolicy: redrivePolicy });
  await ensureQueue(EVENTS_QUEUE);

  const mainAttrs = await getAttributes(mainUrl);
  const problems: string[] = [];

  if (mainAttrs['FifoQueue'] !== 'true') {
    problems.push(
      `${MAIN_QUEUE} não está marcada como FIFO (FifoQueue=${String(mainAttrs['FifoQueue'])})`,
    );
  }
  if (!mainAttrs['RedrivePolicy']) {
    problems.push(
      `${MAIN_QUEUE} está sem RedrivePolicy — mensagens envenenadas nunca chegariam à DLQ`,
    );
  } else {
    const parsed = JSON.parse(mainAttrs['RedrivePolicy']) as {
      maxReceiveCount?: number;
      deadLetterTargetArn?: string;
    };
    if (Number(parsed.maxReceiveCount) !== Number(MAX_RECEIVE_COUNT)) {
      problems.push(
        `maxReceiveCount gravado (${String(parsed.maxReceiveCount)}) difere do configurado (${MAX_RECEIVE_COUNT})`,
      );
    }
    if (parsed.deadLetterTargetArn !== dlqArn) {
      problems.push(
        `deadLetterTargetArn aponta para ${String(parsed.deadLetterTargetArn)}, esperado ${dlqArn}`,
      );
    }
  }

  if (problems.length > 0) {
    console.error('\n  Divergência nos atributos das filas:');
    for (const p of problems) console.error(`  ! ${p}`);
    console.error(
      '\n  O emulador não honrou a configuração. Trocar para LocalStack exige mudar apenas AWS_ENDPOINT_URL.\n',
    );
    process.exit(1);
  }

  console.log(`\n  OK — FIFO ativo, DLQ conectada com maxReceiveCount=${MAX_RECEIVE_COUNT}\n`);
}

main().catch((e: unknown) => {
  console.error('\n  bootstrap-queues falhou:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
