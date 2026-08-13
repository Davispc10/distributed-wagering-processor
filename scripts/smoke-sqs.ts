/**
 * Verifica o COMPORTAMENTO FIFO do emulador, não os atributos: um broker que
 * aceita `FifoQueue=true` e ignora a semântica faria os testes de mensageria
 * passarem por acidente.
 *
 * Uso: AWS_ENDPOINT_URL=http://localhost:54566 bun scripts/smoke-sqs.ts
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const MAIN_QUEUE = process.env.SQS_WAGER_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo';
const DLQ = process.env.SQS_WAGER_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo';
const MAX_RECEIVE_COUNT = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);

const sqs = new SQSClient({
  endpoint,
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

const results: string[] = [];
const fail: (msg: string) => never = (msg) => {
  throw new Error(msg);
};

async function queueUrl(name: string): Promise<string> {
  const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!res.QueueUrl) fail(`fila ${name} não encontrada — rode bootstrap-queues.ts antes`);
  return res.QueueUrl;
}

async function receive(url: string, wait = 1, max = 10): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: wait,
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    }),
  );
  return res.Messages ?? [];
}

async function drain(url: string): Promise<void> {
  try {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
    await new Promise((r) => setTimeout(r, 1500));
    return;
  } catch {
    // PurgeQueue pode não estar implementado — cai no drenar manual
  }
  for (let i = 0; i < 20; i++) {
    const msgs = await receive(url, 0);
    if (msgs.length === 0) break;
    for (const m of msgs) {
      if (m.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
      }
    }
  }
}

async function main(): Promise<void> {
  const mainUrl = await queueUrl(MAIN_QUEUE);
  const dlqUrl = await queueUrl(DLQ);

  await drain(mainUrl);
  await drain(dlqUrl);
  results.push('✓ filas drenadas');

  const dedupId = `dedup-${String(Date.now())}`;
  const send = async (body: string, group: string, dedup: string): Promise<void> => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: mainUrl,
        MessageBody: body,
        MessageGroupId: group,
        MessageDeduplicationId: dedup,
      }),
    );
  };

  await send(JSON.stringify({ n: 1 }), 'wallet-A', dedupId);
  await send(JSON.stringify({ n: 1 }), 'wallet-A', dedupId); // duplicata exata
  results.push('✓ MessageGroupId + MessageDeduplicationId aceitos');

  const afterDedup = await receive(mainUrl, 2);
  if (afterDedup.length !== 1) {
    fail(
      `dedup do broker falhou: esperado 1 mensagem, veio ${String(afterDedup.length)}. ` +
        `A garantia real continua sendo o inbox persistente, mas isso indica divergência do SQS.`,
    );
  }
  results.push('✓ MessageDeduplicationId repetido é deduplicado pelo broker');
  for (const m of afterDedup) {
    if (m.ReceiptHandle) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: mainUrl, ReceiptHandle: m.ReceiptHandle }),
      );
    }
  }

  await drain(mainUrl);
  const stamp = String(Date.now());
  for (const n of [1, 2, 3]) {
    await send(JSON.stringify({ n }), 'wallet-A', `ord-${stamp}-${String(n)}`);
  }

  const ordered: number[] = [];
  for (let i = 0; i < 6 && ordered.length < 3; i++) {
    for (const m of await receive(mainUrl, 1, 10)) {
      const parsed = JSON.parse(m.Body ?? '{}') as { n?: number };
      if (typeof parsed.n === 'number') ordered.push(parsed.n);
      if (m.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: mainUrl, ReceiptHandle: m.ReceiptHandle }),
        );
      }
    }
  }
  if (ordered.join(',') !== '1,2,3') {
    fail(
      `ordenação FIFO quebrada dentro do group: recebido [${ordered.join(',')}], esperado [1,2,3]`,
    );
  }
  results.push('✓ ordenação FIFO preservada dentro do MessageGroupId');

  await drain(mainUrl);
  const gstamp = String(Date.now());
  await send(JSON.stringify({ w: 'A' }), 'wallet-A', `grp-${gstamp}-a`);
  await send(JSON.stringify({ w: 'B' }), 'wallet-B', `grp-${gstamp}-b`);

  const groups = new Set<string>();
  for (let i = 0; i < 5 && groups.size < 2; i++) {
    for (const m of await receive(mainUrl, 1, 10)) {
      const g = m.Attributes?.['MessageGroupId'];
      if (g) groups.add(g);
      if (m.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: mainUrl, ReceiptHandle: m.ReceiptHandle }),
        );
      }
    }
  }
  if (groups.size !== 2) {
    fail(`grupos distintos não foram entregues em paralelo: vi ${String(groups.size)} group(s)`);
  }
  results.push('✓ MessageGroupId distintos são entregues em paralelo (wallets não se bloqueiam)');

  await drain(mainUrl);
  await drain(dlqUrl);

  const poisonId = `poison-${String(Date.now())}`;
  await send(JSON.stringify({ poison: true }), 'wallet-poison', poisonId);

  let receiveCount = 0;
  let landedInDlq = false;

  for (let attempt = 0; attempt < MAX_RECEIVE_COUNT + 2; attempt++) {
    const msgs = await receive(mainUrl, 1, 1);
    if (msgs.length === 0) {
      const inDlq = await receive(dlqUrl, 1, 10);
      if (inDlq.length > 0) {
        landedInDlq = true;
        break;
      }
      continue;
    }
    receiveCount++;
    const m = msgs[0];
    // Nunca deletamos: simula falha transitória repetida.
    if (m?.ReceiptHandle) {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: mainUrl,
          ReceiptHandle: m.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }
  }

  if (!landedInDlq) {
    const inDlq = await receive(dlqUrl, 3, 10);
    landedInDlq = inDlq.length > 0;
  }

  if (receiveCount === 0) {
    fail('a mensagem nunca foi reentregue — ChangeMessageVisibility(0) não funciona');
  }
  results.push(`✓ ChangeMessageVisibility(0) devolve para redelivery (${String(receiveCount)}x)`);

  const dlqAttrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );

  if (!landedInDlq) {
    fail(
      `redrive NÃO funcionou: após ${String(receiveCount)} recebimentos com maxReceiveCount=${String(MAX_RECEIVE_COUNT)}, ` +
        `a DLQ segue com ${String(dlqAttrs.Attributes?.['ApproximateNumberOfMessages'] ?? '0')} mensagens.\n` +
        `  → A Fase 5 precisa mover para a DLQ explicitamente no código, sem depender da redrive policy do broker.`,
    );
  }
  results.push(`✓ redrive automático para a DLQ após maxReceiveCount=${String(MAX_RECEIVE_COUNT)}`);

  await drain(mainUrl);
  await drain(dlqUrl);

  console.log('\n  SMOKE TEST — SQS FIFO no MiniStack\n');
  for (const r of results) console.log(`  ${r}`);
  console.log('\n  Resultado: semântica FIFO viável. Risco "MiniStack divergir do SQS" fechado.\n');
}

main().catch((e: unknown) => {
  console.log('\n  SMOKE TEST — SQS FIFO no MiniStack\n');
  for (const r of results) console.log(`  ${r}`);
  console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
