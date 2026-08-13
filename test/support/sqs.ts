import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { TEST_ENV } from './database';

export const TEST_QUEUES = {
  main: 'wager-transactions.fifo',
  dlq: 'wager-transactions-dlq.fifo',
  events: 'wager-events.fifo',
};

export const sqs = new SQSClient({
  endpoint: TEST_ENV.AWS_ENDPOINT_URL,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export async function queueUrl(name: string): Promise<string> {
  const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!res.QueueUrl) throw new Error(`fila ${name} não existe — rode bun run queues:bootstrap`);
  return res.QueueUrl;
}

export interface WagerMessageInput {
  messageId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency?: string;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export function buildMessage(input: WagerMessageInput): string {
  return JSON.stringify({
    messageId: input.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: { amount: input.amount, currency: input.currency ?? 'BRL' },
      ...(input.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    },
  });
}

export async function sendWagerMessage(
  input: WagerMessageInput,
  options: { dedupSuffix?: string } = {},
): Promise<void> {
  const url = await queueUrl(TEST_QUEUES.main);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: buildMessage(input),
      // walletId como group: ordena por wallet, paraleliza entre wallets.
      MessageGroupId: input.walletId,
      MessageDeduplicationId: `${input.messageId}${options.dedupSuffix ?? ''}`,
    }),
  );
}

export async function sendRaw(body: string, groupId = 'raw'): Promise<void> {
  const url = await queueUrl(TEST_QUEUES.main);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: `${groupId}-${String(Math.floor(performance.now() * 1000))}`,
    }),
  );
}

export async function drainQueue(name: string): Promise<void> {
  const url = await queueUrl(name);
  try {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
    await sleep(1200);
    return;
  } catch {
    // PurgeQueue tem cooldown de 60s no SQS real; drena manualmente.
  }
  for (let i = 0; i < 30; i++) {
    const msgs = await receiveFrom(name, 0, 10);
    if (msgs.length === 0) break;
    for (const m of msgs) {
      if (m.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
      }
    }
  }
}

export async function receiveFrom(name: string, waitSeconds = 1, max = 10): Promise<Message[]> {
  const url = await queueUrl(name);
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return res.Messages ?? [];
}

export async function approximateCount(name: string): Promise<number> {
  const url = await queueUrl(name);
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  return Number(res.Attributes?.['ApproximateNumberOfMessages'] ?? '0');
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `sleep` fixo cria teste lento quando o sistema está rápido e instável quando está lento. */
export async function waitFor<T>(
  probe: () => Promise<T | null>,
  { timeoutMs = 30_000, intervalMs = 200, description = 'condição' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;

  while (Date.now() < deadline) {
    last = await probe();
    if (last !== null) return last;
    await sleep(intervalMs);
  }

  throw new Error(`timeout de ${String(timeoutMs)}ms aguardando: ${description}`);
}
