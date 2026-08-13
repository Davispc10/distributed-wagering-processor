# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas de múltiplos
provedores de jogos, mantendo correção sob entrega **at-least-once**: mensagens
duplicadas, fora de ordem e processadas simultaneamente por várias instâncias.

Resposta ao desafio técnico da Jungle Gaming. O enunciado original está em
[`docs/CHALLENGE.md`](docs/CHALLENGE.md); as decisões e trade-offs estão em
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Linguagem | TypeScript, `strict` |
| Framework | NestJS 11 |
| Banco | PostgreSQL 16 |
| ORM | MikroORM 6 (`EntitySchema`, não decorators) |
| Mensageria | AWS SQS FIFO via MiniStack |
| Decimal | `decimal.js` |
| Observabilidade | pino (JSON) + prom-client |
| Carga (opcional) | k6 |

---

## Pré-requisitos

- [Bun](https://bun.sh) ≥ 1.3
- Docker + Docker Compose
- [k6](https://k6.io) — apenas para `bun run test:load`

---

## Subir tudo

```bash
cp .env.example .env     # opcional: só para rodar fora do Docker e trocar portas
bun install
bun run infra:up
```

`infra:up` cria **9 serviços**: PostgreSQL, MiniStack, bootstrap das filas e
migrations — estes dois rodam uma vez e saem — mais **3 instâncias de API** e
**2 workers**.

```bash
bun run verify:stack
```

```
  ✓ api-1     postgres, sqs
  ✓ api-2     postgres, sqs
  ✓ api-3     postgres, sqs
  ✓ worker-1  postgres, sqs
  ✓ worker-2  postgres, sqs

  OK — stack multi-instância saudável.
```

### Portas

| Serviço | Porta | Variável para trocar |
|---|---|---|
| api-1 | 3000 | `API_1_PORT` |
| api-2 | 3001 | `API_2_PORT` |
| api-3 | 3002 | `API_3_PORT` |
| worker-1 | 3100 | `WORKER_1_PORT` |
| worker-2 | 3101 | `WORKER_2_PORT` |
| PostgreSQL | 5432 | `POSTGRES_HOST_PORT` |
| MiniStack | 4566 | `MINISTACK_HOST_PORT` |

Se alguma porta já estiver ocupada na sua máquina, defina a variável no `.env` —
`verify:stack` lê as mesmas variáveis.

---

## Comandos

**Desenvolvimento**

| Comando | O que faz |
|---|---|
| `bun run dev:api` | API em watch mode |
| `bun run dev:worker` | Worker em watch mode |
| `bun run start:api` / `start:worker` | mesma coisa, sem watch |

**Qualidade**

| Comando | O que faz |
|---|---|
| `bun run typecheck` | `tsc --noEmit`, modo estrito |
| `bun run lint` | Biome + regra de pureza do domínio |
| `bun run format` | Biome formatter (`--write`) |
| `bun run check` | lint + format em uma passada (`check:fix` aplica) |

**Testes**

| Comando | O que faz |
|---|---|
| `bun run test:unit` | domínio e aplicação, sem infra |
| `bun run test:integration` | sobe Postgres + MiniStack reais e roda |
| `bun run test:concurrency` | os 8 cenários de paralelismo real |
| `bun run test` | as três suítes em sequência |
| `bun run test:load` | teste de carga k6 (diferencial) |
| `bun run audit:business-rules` | relatório executável: 59 casos das regras de negócio contra a stack real |

`test:integration` e `test:concurrency` provisionam a própria infra
(`docker-compose.test.yml`, portas 55432/54566) — não precisam da stack de
`infra:up` no ar.

**Infra e operação**

| Comando | O que faz |
|---|---|
| `bun run infra:up` / `infra:down` | stack completa (3 APIs + 2 workers) |
| `bun run infra:test:up` / `infra:test:down` | infra isolada dos testes |
| `bun run infra:observability:up` / `:down` | Prometheus + Grafana (profile opt-in) |
| `bun run verify:stack` | confirma 3 APIs + 2 workers saudáveis |
| `bun run migration:up` / `:down` / `:create` | aplica / reverte / cria |
| `bun run migration:verify` | up → down → up, provando reversibilidade |
| `bun run queues:bootstrap` | cria as filas FIFO + redrive policy |
| `bun run queues:seed` | publica BETs na fila de entrada (exercita o consumidor) |

---

## API

Todos os exemplos assumem `http://localhost:3000`.

**Autenticação não foi implementada** — decisão consciente, registrada em
[`ARCHITECTURE.md` §10](ARCHITECTURE.md), que descreve o desenho OIDC que seria
adotado e o ponto de extensão (`AuthGuard`) já presente no código. Pelo
enunciado (seção 2) autenticação não vale pontos, e o tempo foi para correção
financeira, concorrência e idempotência.

### Collection do Insomnia

Os 10 endpoints estão prontos em
[`docs/insomnia-collection.json`](docs/insomnia-collection.json) — 14 requests em três
pastas (Health, Wallets, Wagering), com descrição de cada status de resposta e das
regras de referência de `REFUND`/`ROLLBACK`.

`File → Import` no Insomnia e selecione o arquivo. Depois escolha o environment
**Local (docker compose)**.

Duas variáveis nascem como **placeholder** e precisam ser preenchidas — `walletId` e
`transactionId`. Rode `POST Abrir carteira` primeiro e cole o `id` da resposta em
`walletId`; qualquer POST de wagering devolve o `transactionId`. Não versionei IDs
reais de propósito: eles morrem no primeiro `docker compose down -v`, e um arquivo com
IDs mortos dá 404 para quem clona.

Os requests de wagering estão numerados e encadeados — `BET` cria `bet-0100`, e
`REFUND`/`ROLLBACK` referenciam ele. Rodando na ordem, todos retornam `201` na primeira
execução; reenviar qualquer um devolve `200` com `idempotentReplay: true`, que é o jeito
mais rápido de ver a idempotência funcionando.

### Criar wallet

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

```json
{
  "id": "019feee4-827f-7342-b33c-098a6e977424",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

Saldo inicial maior que zero gera uma transação interna `OPENING` com lançamento
`CREDIT` na mesma transação SQL. Segunda wallet para o mesmo `playerId` + moeda
falha com `409 WALLET_ALREADY_EXISTS` — a garantia é o
`UNIQUE (player_id, currency)`, não uma checagem em código.

### Submeter transação

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "019feee4-827f-7342-b33c-098a6e977424",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

```json
{
  "transactionId": "019feee4-82a6-7628-b7ca-4ee23526be76",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

O header `Idempotency-Key` é **obrigatório**.

São **duas unicidades independentes**: a `Idempotency-Key` e o par
`(providerId, externalTransactionId)`. Reenviar a mesma transação do provedor sob uma
key nova passa pela primeira e é barrada pela segunda — `409`, nunca replay: aceitar
seria deixar o provedor trocar o valor de uma transação já processada.

| Situação | Status |
|---|---|
| Processada agora | `201` |
| Replay (mesma key, mesmo payload) | `200` + `idempotentReplay: true` |
| Aguardando referência | `202` + `PENDING_REFERENCE` |
| Rejeitada por regra de negócio | `422` + `failureCode` |
| Payload inválido / header ausente | `400` |
| Mesma key com payload diferente | `409` + `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| Mesmo `externalTransactionId` sob outra key | `409` + `DUPLICATE_PROVIDER_TRANSACTION` |
| Wallet inexistente | `404` |
| Falha transitória | `503` + `Retry-After` |

Toda rejeição carrega um `failureCode` estável e legível por máquina — a
taxonomia completa e o que o provedor deve fazer com cada um estão em
[`ARCHITECTURE.md` §7](ARCHITECTURE.md).

### Consultas

```bash
curl http://localhost:3000/wallets/{walletId}
curl "http://localhost:3000/wallets/{walletId}/ledger?limit=50"
curl "http://localhost:3000/wallets/{walletId}/ledger?limit=50&cursor={nextCursor}"
curl http://localhost:3000/wagering/transactions/{transactionId}
curl http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

### Reconciliação

```bash
curl -X POST http://localhost:3000/wallets/{walletId}/reconciliation
```

```json
{
  "walletId": "019feee4-827f-7342-b33c-098a6e977424",
  "storedBalance":     { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

Divergências não são corrigidas silenciosamente: são logadas, contabilizadas em
`reconciliation_mismatch_total` e sinalizadas com `consistent: false`.

### Health e métricas

```bash
curl http://localhost:3000/health/live    # processo vivo
curl http://localhost:3000/health/ready   # PostgreSQL e SQS alcançáveis
curl http://localhost:3000/metrics        # Prometheus
```

Nenhum deles exige autenticação.

---

## Enviar pela fila

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "019feee4-827f-7342-b33c-098a6e977424" \
  --message-deduplication-id "msg-123" \
  --message-body '{
    "messageId": "msg-123",
    "type": "WagerTransactionRequested",
    "occurredAt": "2026-08-11T00:00:00.000Z",
    "data": {
      "providerId": "provider-a",
      "externalTransactionId": "transaction-456",
      "idempotencyKey": "provider-a:transaction-456",
      "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      "walletId": "019feee4-827f-7342-b33c-098a6e977424",
      "roundId": "round-987",
      "gameId": "fortune-chimp",
      "kind": "BET",
      "money": { "amount": "25.00", "currency": "BRL" }
    }
  }'
```

O consumidor chama **o mesmo use case** do endpoint HTTP.

Para gerar carga em lote nessa fila, sem montar o envelope na mão:

```bash
bun run queues:seed              # cria uma wallet e publica 25 BETs
SEED_COUNT=200 bun run queues:seed
```

---

## Testes

**256 testes**, com PostgreSQL e MiniStack **reais** em containers.

```
bun run test:unit          181 pass    (domínio e aplicação)
bun run test:integration    63 pass    (constraints, atomicidade, regras de negócio, mensageria, double-entry)
bun run test:concurrency    12 pass    (os 8 cenários da seção 13)
```

Toda suíte de integração e concorrência termina afirmando a mesma invariante:

```
wallet.balance == saldo reconstruído pelo ledger
```

### Cenários de concorrência

| # | Cenário | Asserção |
|---|---|---|
| 1 | Mesma aposta 50× em paralelo sobre 3 instâncias | exatamente **um** débito, um único `transactionId` |
| 2 | **Obrigatório:** saldo `100.00`, duas apostas de `80.00` | `[201, 422]`, saldo `20.00`, **um** débito |
| 3 | 8 wallets × 5 apostas em paralelo | sem interferência, todas consistentes |
| 4 | 3 workers na mesma fila e mesma wallet | 20 apostas, saldo exato |
| 5 | Reentrega após commit; `SIGKILL` durante o processamento | nenhum efeito duplicado |
| 6 | 2 publishers, 25 eventos | outbox drenada, `attempts = 0` |
| 7 | `ROLLBACK` antes da `BET` | `202` → worker resolve quando a referência chega |
| 8 | Todos os workers derrubados e substituídos | trabalho pendente retomado |

Instâncias sobem como **processos separados** (`bun spawn`), não módulos em
memória — só assim o lock disputado é o do PostgreSQL.

---

## Observabilidade local

Métricas Prometheus já saem em `/metrics` nas três APIs (`3000/3001/3002`) e nos dois
workers (`3100/3101`). Para vê-las em gráfico:

```bash
bun run infra:up                  # aplicação
bun run infra:observability:up    # Prometheus + Grafana
```

Grafana em **<http://localhost:3300>** — sem login, dashboard *Wagering — visão geral*
já provisionado. Prometheus em <http://localhost:9090>.

Sobe atrás do profile `observability`: `bun run infra:up` continua subindo só a
aplicação, para rodar a suíte de testes sem depender de Grafana.

**O detalhe não óbvio: são dois caminhos separados.** `POST /wagering/transactions`
grava no outbox, que o publisher envia para `wager-events.fifo` — isso move o painel de
saída. Já o consumidor lê `wager-transactions.fifo`, e **nenhuma rota HTTP escreve
nela**. Sem `bun run queues:seed`, os painéis de entrada ficam em zero e parecem
quebrados. Para exercitar os dois de uma vez:

```bash
bun run test:load     # caminho HTTP
bun run queues:seed   # caminho fila
```

Os painéis cobrem fluxo e profundidade das filas, DLQ, transações por kind e status,
latência p50/p95/p99, lag e pendências do outbox, duplicatas, retries e conflitos de
lock. Dois painéis leem o Postgres direto: a tabela do outbox mostra o **payload
completo** do que saiu; o do inbox mostra o ritmo de consumo — mas o inbox guarda
`payload_hash`, não o conteúdo, então ele responde *quando* consumiu, nunca *o quê*.

Profundidade de fila usa `max by (queue)`, nunca `sum`: os dois workers reportam a mesma
série e somar dobraria o número. Sem volume — `docker compose down` zera o histórico.

---

## Estrutura

```
src/
├── main-api.ts / main-worker.ts       entrypoints
├── bootstrap.ts                       boot compartilhado, shutdown hooks
├── app/
│   ├── ApiModule.ts                   só HTTP — nunca consome fila
│   └── WorkerModule.ts                consumidor SQS + workers
├── shared/                            config (zod), logger, métricas, MikroORM, SQS, AuthGuard
└── modules/
    ├── kernel/     Money, FailureCode, erros, IntegrationEvent, PayloadHasher
    ├── wallet/     Wallet, WalletLedgerEntry, Journal, reconciliação
    ├── wagering/   WagerTransaction, SubmitWagerTransactionUseCase, consumidor SQS
    ├── messaging/  inbox, outbox, publisher
    └── health/     liveness, readiness, /metrics
```

Cada módulo segue `domain/` (puro) → `application/{usecase,port,dto}` →
`infra/{persistence,http,messaging,worker}`. A regra de import é verificada por
lint. Detalhes em [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | decisões, trade-offs, alternativas descartadas, premissas e limitações |
| [`docs/LOAD-TEST.md`](docs/LOAD-TEST.md) | teste de carga: ambiente, metodologia, números e limitações |
| [`docs/EVALUATION-CHECKLIST.md`](docs/EVALUATION-CHECKLIST.md) | mapeamento requisito → implementação → teste |
| [`docs/CHALLENGE.md`](docs/CHALLENGE.md) | enunciado original |
| [`docs/insomnia-collection.json`](docs/insomnia-collection.json) | collection do Insomnia com os 10 endpoints |
| [`AGENTS.md`](AGENTS.md) | convenções para quem for mexer no código |
