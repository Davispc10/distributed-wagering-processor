# AGENTS.md

Serviço financeiro distribuído que processa transações de apostas (desafio técnico Jungle Gaming).
O `README.md` é a documentação de entrega; o enunciado original está em `docs/CHALLENGE.md`.

## Ambiente

- **Bun 1.x** é runtime, package manager **e** test runner. Não use `npm`, `pnpm`, `yarn` nem Jest.
- `bun install` — dependências
- `bun run dev:api` / `bun run dev:worker` — os dois entrypoints
- `docker compose up -d --wait --build` — Postgres, MiniStack, 3 APIs, 2 workers.
  Sem `--build` o compose reaproveita a imagem existente e roda código antigo em silêncio.
- `bun run migration:up` — aplica as migrations

## Testes

```bash
bun run test:unit          # 127 testes — domínio e aplicação, sem infra
bun run test:integration   #  48 testes — Postgres + MiniStack reais
bun run test:concurrency   #  12 testes — os 8 cenários de paralelismo real
bun run typecheck          # tsc --noEmit, modo estrito
bun run lint               # Biome + regra de pureza do domínio
```

Módulos existentes: `kernel`, `wallet`, `wagering`, `messaging`, `health`.

Substituir Postgres e SQS por mocks é **falha eliminatória** do desafio. Todo teste de integração e concorrência termina com `assertWalletConsistency(walletId)` — `wallet.balance == saldo reconstruído pelo ledger`.

## Regras não negociáveis

1. **Nunca** `number`, `float` ou `double` para dinheiro. Use `Money` sobre `decimal.js`. O lint bloqueia `parseFloat`, `Number()` e `Math.round` dentro de `modules/*/domain`.
2. **`modules/*/domain` é puro** — sem `@nestjs/*`, `@mikro-orm/*`, `@aws-sdk/*`, sem `infra/`, sem `shared/`, sem `application/`. O lint quebra o build se você importar. Inverta com um port em `application/port/`.
3. **Nenhum evento é publicado antes do commit.** Eventos só entram em `outbox_messages`; quem publica é o worker.
4. **A wallet é sempre o primeiro lock** da transação (`SELECT ... FOR UPDATE`). Ordem fixa elimina deadlock cíclico.
5. **`ack` do SQS só depois do commit.**
6. **Nada de lock global** e nada de idempotência em memória — é persistente, no banco.
7. **Ledger é imutável**: trigger + `REVOKE UPDATE, DELETE`. Nunca sobrescreva nem exclua lançamento.
8. Construtor de entidade de domínio é `private`; criação por factory estática; `rehydrate` **não** revalida transições.

## Onde está o quê

Módulos isolados por feature. Estrutura service-based, mas com **use cases** no lugar do Service único.

```
src/
├── main-api.ts / main-worker.ts       entrypoints
├── bootstrap.ts                       boot compartilhado (shutdown hooks, logger)
├── app/
│   ├── ApiModule.ts                   só HTTP — NUNCA importa consumidor de fila
│   └── WorkerModule.ts                consumidor SQS + workers de background
├── shared/                            config (zod), logger, métricas, MikroORM, SQS, AuthGuard
└── modules/{nome}/
    ├── domain/{Entity}.ts             puro; construtor privado + factories
    ├── application/usecase/{Action}{Entity}UseCase.ts
    ├── application/port/{Entity}Repository.ts
    ├── application/dto/
    ├── infra/persistence/ | http/ | messaging/
    └── {Nome}Module.ts
```

**Ao criar um módulo de feature:** o `{Nome}Module` core exporta os use cases; `{Nome}HttpModule` (controllers) entra no `ApiModule` e `{Nome}ConsumerModule` (consumidor SQS) entra no `WorkerModule`. Os dois adapters chamam o **mesmo** use case — é o que a seção 10 do desafio exige.

Nomes de arquivo: **PascalCase** para classes, camelCase para configs e schemas. Segue a convenção do time, não o kebab-case padrão do Nest.

## Antes de dizer que algo está pronto

Rode os sensores da fase e **cole a saída**. Sem evidência, sem afirmação de "passou" — é o gate `execution_evidence` do workflow e é o que a seção 13 do desafio espera.

## Contexto do projeto

| Arquivo | Conteúdo |
|---|---|
| `.context/plans/distributed-wagering-processor.md` | plano de 10 fases. **Apêndice A** (schema/constraints), **Apêndice B** (fluxo transacional canônico), **Apêndice C** (failureCode + status HTTP), **Apêndice D** (cobertura do enunciado) |
| `.context/docs/architecture.md` | camadas, concorrência, idempotência, atomicidade |
| `.context/docs/glossary.md` | linguagem ubíqua e as regras que costumam ser lidas errado |
| `.context/docs/data-flow.md` | caminho de uma transação, filas, outbox, referências fora de ordem |
| `.context/docs/testing-strategy.md` | as camadas de teste e os 8 cenários obrigatórios |

Ferramentas de workflow: `workflow-status`, `workflow-guide`, `plan getDetails`, `plan recordDecision`, `workflow-advance`.

Se você mudar a ordem dos passos do fluxo transacional, **atualize o Apêndice B junto** — ele é a referência que todas as sessões futuras leem.
