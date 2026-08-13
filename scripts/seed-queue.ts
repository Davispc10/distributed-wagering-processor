/**
 * Publica transações em `wager-transactions.fifo` para exercitar o consumidor.
 * Nenhuma rota HTTP escreve nesta fila — ela é alimentada por provedores, então
 * sem este script os painéis de entrada/saída ficam parados e parecem quebrados.
 *
 * Uso: bun run queues:seed
 *
 * Cria a wallet sozinho se `SEED_WALLET_ID`/`SEED_PLAYER_ID` não vierem do
 * ambiente; passe os dois para acumular carga numa carteira já existente.
 */
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const ENDPOINT = process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566';
const API_URL = process.env['SEED_API_URL'] ?? 'http://localhost:3000';
const QUEUE = process.env['SQS_WAGER_TRANSACTIONS_QUEUE'] ?? 'wager-transactions.fifo';
const COUNT = Number(process.env['SEED_COUNT'] ?? 25);

interface WalletRef {
  walletId: string;
  playerId: string;
}

async function resolveWallet(): Promise<WalletRef> {
  const walletId = process.env['SEED_WALLET_ID'];
  const playerId = process.env['SEED_PLAYER_ID'];
  if (walletId !== undefined && playerId !== undefined) return { walletId, playerId };

  const newPlayerId = crypto.randomUUID();
  const res = await fetch(`${API_URL}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId: newPlayerId,
      // Alto o bastante para as BETs do seed não esbarrarem em saldo insuficiente.
      initialBalance: { amount: '100000.00', currency: 'BRL' },
    }),
  });

  if (!res.ok) {
    throw new Error(`Falha ao criar wallet em ${API_URL}: HTTP ${String(res.status)}`);
  }

  const wallet = (await res.json()) as { id: string; playerId: string };
  console.log(`wallet criada: ${wallet.id}`);

  return { walletId: wallet.id, playerId: wallet.playerId };
}

const { walletId, playerId } = await resolveWallet();

const client = new SQSClient({
  endpoint: ENDPOINT,
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: QUEUE }));
if (QueueUrl === undefined) {
  throw new Error(
    `Fila "${QUEUE}" não encontrada em ${ENDPOINT}. Rode "bun run queues:bootstrap".`,
  );
}

for (let i = 0; i < COUNT; i++) {
  const externalTransactionId = `seed-${String(Date.now())}-${String(i)}`;

  // Envelope conforme `wagerTransactionMessageSchema`: `messageId` vem do CORPO,
  // porque a chave do inbox precisa sobreviver a uma republicação.
  const body = {
    messageId: externalTransactionId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'seed-provider',
      externalTransactionId,
      idempotencyKey: `seed-provider:${externalTransactionId}`,
      playerId,
      walletId,
      roundId: `seed-round-${String(i)}`,
      gameId: 'seed-game',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
      correlationId: crypto.randomUUID(),
    },
  };

  await client.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(body),
      // Mesma wallet no mesmo grupo: preserva a ordem por carteira, como em produção.
      MessageGroupId: walletId,
      MessageDeduplicationId: externalTransactionId,
    }),
  );
}

console.log(`${String(COUNT)} mensagens publicadas em ${QUEUE} para a wallet ${walletId}`);
client.destroy();
