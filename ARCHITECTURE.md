# ARCHITECTURE.md

Decisões, trade-offs e limitações do **Distributed Wagering Processor**.

O enunciado original está preservado em [`docs/CHALLENGE.md`](docs/CHALLENGE.md).

---

## 1. Organização do código

App NestJS único, **módulos isolados por feature**, dois entrypoints. A separação
que importa não é de deploy — é de **dependência**.

```
src/modules/{nome}/
├── domain/                      puro. Sem NestJS, sem ORM, sem AWS SDK.
├── application/
│   ├── usecase/{Action}{Entity}UseCase.ts
│   ├── port/{Entity}Repository.ts       interfaces implementadas em infra/
│   └── dto/
├── infra/
│   ├── persistence/  http/  messaging/  worker/
└── {Nome}Module.ts
```

Estrutura service-based, com o Service único trocado por **use cases nomeados**:
este domínio tem máquina de estados, resolução de referência e idempotência, o
que num service único viraria um método de 200 linhas.

Módulos: `kernel` (Money, erros, envelope de evento), `wallet`, `wagering`,
`messaging` (inbox/outbox), `health`.

### A regra de import é verificada por lint

| Camada | Não pode importar |
|---|---|
| `modules/*/domain/**` | `@nestjs/*`, `@mikro-orm/*`, `@aws-sdk/*`, `pino`, `prom-client`, `class-validator`, `**/infra/**`, `**/shared/**`, `**/application/**` |
| `modules/*/application/**` | `@mikro-orm/*`, `@aws-sdk/*`, `pino`, `express`, `**/infra/**` |

`@nestjs/common` é permitido em `application/` — só `@Injectable`/`@Inject`.

A regra também proíbe `parseFloat`, `Number()` e `Math.round` dentro de
`domain/`. Não é estética: é o que garante que a seção 6.1 ("o domínio não
depende de tipos monetários do ORM nem de decorators do NestJS") continue
verdadeira depois da décima alteração. Sem automação, essa propriedade dura até
a primeira pressa.

O linter é o **Biome**. As restrições de import e `parseFloat`/`parseInt` são
`overrides` por camada em `biome.jsonc`; `Number()` e `Math.round/floor/ceil`
vivem em `lint/domain-money-purity.grit`, um plugin GritQL escopado a
`modules/*/domain/**` — casar uma forma de AST arbitrária não é expressável em
regra de config, só em plugin.

### Dois composition roots

```
src/app/ApiModule.ts      SharedModule + Health + WalletHttpModule + WageringHttpModule
src/app/WorkerModule.ts   SharedModule + Health + WageringWorkerModule + OutboxPublisherModule
```

O que o `ApiModule` **não** importa é tão importante quanto o que importa:
nenhum consumidor de fila. Se uma instância de API pudesse consumir SQS por
acidente de configuração, escalar a API para absorver tráfego HTTP
multiplicaria também os consumidores da fila — e a separação viraria ficção.

Os dois adapters (`WageringHttpModule` e `WageringWorkerModule`) são camadas
finas sobre o mesmo `WageringModule`, que exporta o
`SubmitWagerTransactionUseCase`. **O consumidor SQS e o controller HTTP chamam a
mesma instância da mesma classe** (exigência da seção 10).

---

## 2. Escolha do ORM: MikroORM

Preferencial no enunciado, e a escolha se sustenta por três motivos concretos:

1. **`em.transactional()`** dá uma fronteira transacional explícita, que é onde
   toda a atomicidade da seção 11 acontece.
2. **`LockMode.PESSIMISTIC_WRITE`** expõe `SELECT ... FOR UPDATE` sem SQL cru.
3. **Unit of Work e Identity Map explícitos** — sabemos quando o flush acontece,
   o que importa quando a ordem dos INSERTs precisa respeitar chaves
   estrangeiras.

### EntitySchema, não decorators

Decidido depois de um smoke test (`scripts/smoke-mikro-orm.ts`) que validou a
stack sob Bun. `EntitySchema` dispensa `emitDecoratorMetadata` — eliminando uma
classe inteira de problemas de metadata — e mantém o mapeamento fisicamente
fora da classe, o que impede o atalho de usar a entidade ORM como entidade de
domínio.

### Mapeamento do `Money`

Colunas separadas: `numeric(20,2)` para o valor e `char(3)` para a moeda.

- `numeric` é exato. `float8` não é, e num ledger a diferença aparece como
  centavos que ninguém consegue explicar.
- O driver `pg` devolve `numeric` como **string**, que vai direto para
  `Money.parse`. Em nenhum ponto do caminho banco → domínio o valor passa por
  `number`. Há um teste de integração que verifica exatamente isso.
- Escala fixa de 2 na serialização (`toFixed(2)`), sempre.

Internamente `Money` usa `decimal.js` com precisão 34 e `ROUND_HALF_EVEN`. Na
prática nunca arredondamos: soma e subtração de valores com 2 casas são exatas
por construção.

Validação de entrada por regex (`/^-?(0|[1-9]\d*)(\.\d{1,2})?$/`), que rejeita
por construção string vazia, `NaN`, `Infinity`, notação científica, separador de
milhar, espaços e 3+ casas decimais.

`Money.from` rejeita negativos (contrato de entrada); `Money.parse` os aceita,
para reidratação e para o lançamento invertido de um `ROLLBACK`.

---

## 3. Estratégia de concorrência

**Unidade de concorrência: `walletId`.** Três camadas:

### 3.1 Lock pessimista por linha

`SELECT ... FOR UPDATE` na wallet, **sempre o primeiro lock da transação**.

Não é lock global (proibido pela seção 5.6): wallets diferentes não se
bloqueiam, o que os testes de concorrência verificam explicitamente. A ordem
fixa de aquisição elimina deadlock cíclico.

**Alternativas descartadas:**

| Alternativa | Por que não |
|---|---|
| Optimistic locking com retry limitado | Sob hot wallet vira retry storm. O teste de carga mostra que a versão pessimista mantém p99 em 101ms com 20 VUs numa única wallet, sem nenhum retry — porque a fila do lock é justa e finita. Com optimistic, cada conflito vira trabalho jogado fora. |
| `UPDATE ... WHERE balance >= :valor` | Resolve o saldo, mas não serializa a leitura do `balanceBefore` que o lançamento no ledger precisa. Teríamos saldo correto e ledger inconsistente. |
| Advisory lock por hash do `walletId` | Não protege contra escrita direta no banco e não é visível no schema. Colisão de hash serializaria wallets sem relação. |

### 3.2 `version` incremental

Incrementa **somente quando o saldo muda** (um `LOSS` processado não mexe nela).
Serve de optimistic locking para consumidores dos eventos, que recebem
`walletVersion` no `WalletBalanceChanged` e conseguem descartar eventos fora de
ordem.

### 3.3 `CHECK (balance_amount >= 0)`

Rede final. Saldo negativo é impossível mesmo com bug de aplicação ou escrita
direta no banco. Há um teste que prova que o banco recusa o `UPDATE`.

### Timeouts

`lock_timeout = 3s` e `statement_timeout = 10s` aplicados por conexão. Convertem
contenção patológica em **erro transitório retentável** (`503` + `Retry-After`),
em vez de uma requisição pendurada segurando o lock e travando a fila daquela
wallet. Os SQLSTATE `40001`, `40P01`, `55P03`, `57014` e `08*` são traduzidos em
`TransientInfrastructureError`.

---

## 4. Idempotência

Persistente, nunca em memória (seção 5.2).

### Do lado HTTP

- O header `Idempotency-Key` é **obrigatório** e é a fonte da verdade.
- `UNIQUE (idempotency_key)` no banco é a garantia final.
- Mesma key + mesmo `payloadHash` → **replay**, com `idempotentReplay: true`.
- Mesma key + hash diferente → **`409`**, e nunca replay.

### Algoritmo do `payloadHash`

1. selecionar **apenas** os campos de negócio (`providerId`,
   `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
   `money`, `referenceExternalTransactionId`);
2. descartar chaves com valor `undefined`;
3. serializar em JSON com as chaves ordenadas alfabeticamente, **de forma
   recursiva** (JSON canônico);
4. SHA-256 sobre os bytes UTF-8, saída em hex minúsculo (64 caracteres).

O header e os metadados de transporte ficam **fora** do hash de propósito: a
mesma operação submetida por HTTP e por SQS precisa produzir o mesmo hash,
senão um replay legítimo viraria conflito.

A ordenação recursiva é o ponto crítico. `{"amount":"25.00","currency":"BRL"}` e
`{"currency":"BRL","amount":"25.00"}` são o mesmo payload de negócio; sem
canonicalização produziriam hashes diferentes, e o resultado dependeria da ordem
em que o provedor montou o JSON. Como `money.amount` já é string decimal, o hash
nunca depende de formatação de ponto flutuante.

### Do lado da fila

Inbox persistente com `PRIMARY KEY (consumer_name, message_id)`. O
`INSERT ... ON CONFLICT DO NOTHING` resolve a corrida entre entregas duplicadas
e classifica em três casos:

| Resultado | Significado | Ação |
|---|---|---|
| inseriu | primeira vez | processa |
| conflito + `processed_at` preenchido | duplicata da entrega at-least-once | ack, sem reprocessar |
| conflito + `processed_at` nulo | outra instância está processando **agora** | devolve a visibilidade |

O `messageId` usado é o do **corpo** da mensagem, não o `MessageId` do broker:
a chave precisa sobreviver a uma republicação pelo provedor, e o id do broker
muda a cada envio.

### Replay fiel do saldo

A seção 7.7 exige que um replay retorne "o saldo observado naquele momento".
`LOSS` e transações `REJECTED` não geram lançamento no ledger, então o ledger
não serve como fonte universal. Gravamos `observed_balance_amount` e
`observed_balance_currency` na própria linha de `wager_transactions` no commit —
o replay vira uma leitura simples e exata para **todos** os kinds e status.

---

## 5. Atomicidade e o fluxo transacional

Uma única transação SQL cobre: registro de inbox (quando a entrada é SQS),
persistência da transação, lançamento no ledger, journal de partidas dobradas,
alteração do saldo e o evento de integração na outbox.

```
SET LOCAL lock_timeout = 3s; SET LOCAL statement_timeout = 10s;

 1. [SQS] inbox claim (ON CONFLICT DO NOTHING)     resolve a corrida entre duplicatas
 2. SELECT wallet FOR UPDATE                       SEMPRE o primeiro lock
 3. dedup por idempotency_key                      já sob o lock: enxerga o commit anterior
 4. resolver referência (REFUND/ROLLBACK)
 5. WagerRuleEngine decide
 6. movimento calculado em memória
 7. INSERT/UPDATE wager_transactions               ANTES do ledger: FK
 8. INSERT ledger entry + journal + UPDATE saldo
 9. INSERT outbox (1 ou 2 eventos)
10. [SQS] inbox mark processed

COMMIT  →  só então: ack SQS / resposta HTTP
```

**Por que o passo 2 vem antes do 3.** Duas entregas simultâneas da mesma
transação se serializam no lock da wallet; quando a segunda entra, já vê a
primeira como `PROCESSED` e vira replay em vez de débito duplicado. Se a
verificação de idempotência viesse antes do lock, ambas leriam "não existe" e
ambas debitariam.

**Por que o passo 7 vem antes do 8.** `wallet_ledger_entries.transaction_id` tem
FK para `wager_transactions`. A ordem é indiferente para a atomicidade (tudo
commita junto) e obrigatória para a chave estrangeira. Este bug apareceu em
teste antes de aparecer em produção.

**Rejeição de negócio também commita.** A transação `REJECTED` é auditável e
gera evento; o que não acontece é lançamento no ledger nem alteração de saldo
(seção 7.6). Fazer rollback apagaria o rastro e o provedor reenviaria
eternamente a mesma operação inválida.

### Nenhum evento antes do commit

O evento nunca é publicado no use case — ele vira **linha em `outbox_messages`**
dentro da mesma transação. Quem publica é um worker separado, depois. Isso não é
convenção: é estrutural, e há um teste de integração que sobe a API **sem** o
worker e verifica que `published_at` continua nulo.

---

## 6. Transactional Outbox

```
UPDATE outbox_messages SET locked_by = ?, locked_until = now() + 30s
 WHERE id IN (SELECT id FROM outbox_messages
               WHERE published_at IS NULL AND due AND lease livre
               ORDER BY next_attempt_at NULLS FIRST, occurred_at
               FOR UPDATE SKIP LOCKED LIMIT 50)
```

`SKIP LOCKED` é o coração do publisher concorrente: N publishers pegam lotes
**disjuntos** sem bloquear um ao outro. O teste de concorrência 6 verifica que,
com dois publishers e 25 eventos, nenhum evento precisou de retry — prova de que
não houve disputa pela mesma linha.

A publicação acontece **fora** da transação do claim. Manter a transação aberta
durante uma chamada de rede seguraria locks pelo tempo de latência do SQS, o
que sob carga vira contenção no banco.

O cenário exigido pela seção 11:

1. o PostgreSQL confirma o commit;
2. o processo morre antes de publicar;
3. **o lease expira e outro publisher assume**;
4. o evento é publicado;
5. a duplicata é segura — o consumidor deduplica pelo inbox e o `eventId` é
   estável (`MessageDeduplicationId = eventId`).

Backoff exponencial `2^n` segundos saturando em 300s. Além disso, o problema
não é transitório.

### Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de operações |
| `wager-transactions-dlq.fifo` | destino após `maxReceiveCount = 5` |
| `wager-events.fifo` | saída dos eventos de integração |

`MessageGroupId = walletId` na entrada (ordena por wallet, paraleliza entre
wallets) e `= aggregateId` na saída. `MessageDeduplicationId = idempotencyKey` /
`eventId`.

**Ordenação e dedup do broker são otimização, não garantia** (seção 5.3). O
teste de dedup do inbox burla deliberadamente a deduplicação do SQS (variando o
`MessageDeduplicationId`) para provar que o **banco** segura.

---

## 7. Classificação de erros

| Classe | Exemplo | HTTP | SQS |
|---|---|---|---|
| **Negócio** (terminal) | saldo insuficiente, referência já revertida | `422` + `failureCode` | ack (o `REJECTED` já commitou) |
| **Transitório** | Postgres fora, lock timeout, throttle | `503` + `Retry-After` | não deleta; `ChangeMessageVisibility` com backoff |
| **Permanente** | payload malformado, schema inválido | `400` | linha `FAILED` + DLQ **explícita** |

Erro desconhecido é tratado como **transitório** de propósito: preferimos
retentar e eventualmente cair na DLQ pelo `maxReceiveCount` a descartar uma
transação financeira por causa de um bug nosso.

A DLQ explícita existe porque esperar 5 recebimentos por um payload que nunca
vai ser válido só atrasa o diagnóstico e ocupa o consumidor.

### `FAILED`: o terminal auditável do erro permanente

A seção 6.3 define `FAILED` como terminal de erro permanente de infraestrutura,
**auditável**. Mandar a mensagem para a DLQ e não gravar nada faria a operação
sumir do banco: o provedor consultaria
`GET /providers/:id/wagering/transactions/:externalId` e receberia `404`, sem
saber se a operação foi perdida ou nunca chegou.

Por isso o ramo `permanent` do consumidor chama
`RecordFailedWagerTransactionUseCase` **antes** da DLQ:

| Situação | Efeito |
|---|---|
| Transação existe e não é terminal | `fail(code)` — vira `FAILED` |
| Transação já é `PROCESSED`/`REJECTED`/`FAILED` | intocada; a verdade auditada não é sobrescrita |
| Transação não existe, payload forma operação válida | linha nova já em `FAILED` |
| Payload não forma operação válida, ou wallet inexistente | só DLQ — as `CHECK`s do schema recusariam a linha |

O registro é **best-effort por decisão**: falhar ao auditar nunca pode impedir a
mensagem de chegar à DLQ, senão um problema de escrita vira mensagem presa em
loop de redelivery.

### Mapeamento HTTP completo

| Situação | Status | O provedor deve |
|---|---|---|
| Payload inválido / `Idempotency-Key` ausente | `400` | corrigir e reenviar |
| Recurso inexistente | `404` | corrigir |
| Mesma key com payload diferente | `409` | corrigir a key ou o payload |
| Wallet duplicada para player+moeda | `409` | usar a existente |
| Rejeição por regra de negócio | `422` + `failureCode` | desistir ou corrigir; **não** reenviar igual |
| Aceita, aguardando referência | `202` | aguardar o evento |
| Processada agora | `201` | seguir |
| Replay de transação já processada | `200` + `idempotentReplay: true` | seguir |
| Falha transitória | `503` | reenviar |

`WALLET_NOT_FOUND` e `WALLET_ALREADY_EXISTS` saem como `404`/`409` e não `422`
porque são conflitos de **recurso**, não rejeições de regra: um `422` faria o
provedor achar que a operação foi avaliada e recusada, quando o alvo nem existe.

### Taxonomia de `failureCode`

`VALIDATION_ERROR` · `IDEMPOTENCY_PAYLOAD_MISMATCH` · `WALLET_NOT_FOUND` ·
`WALLET_ALREADY_EXISTS` · `WALLET_CURRENCY_MISMATCH` · `PLAYER_WALLET_MISMATCH` ·
`INSUFFICIENT_FUNDS` · `REVERSAL_INSUFFICIENT_FUNDS` · `REFERENCE_REQUIRED` ·
`REFERENCE_NOT_FOUND` · `REFERENCE_NOT_PROCESSED` · `REFERENCE_SCOPE_MISMATCH` ·
`REFERENCE_KIND_NOT_REVERSIBLE` · `REFERENCE_AMOUNT_MISMATCH` ·
`REFERENCE_ALREADY_REVERSED` · `INVALID_TRANSACTION_KIND` ·
`INFRASTRUCTURE_UNAVAILABLE`

**`INSUFFICIENT_FUNDS` e `REVERSAL_INSUFFICIENT_FUNDS` são deliberadamente
distintos** (seção 7.9). A primeira é uma aposta sem saldo: situação normal, o
jogador precisa depositar, não há o que investigar. A segunda é uma reversão que
deixaria a wallet negativa — significa que o dinheiro já saiu e a reversão
chegou tarde. É problema operacional real, que precisa de intervenção humana,
não de retry. Colapsar os dois faria o segundo desaparecer no ruído do primeiro.

---

## 8. Garantias no schema

A seção 5.9 exige que unicidade, imutabilidade e não-negatividade vivam **no
banco**. Cada constraint abaixo tem um teste que prova que o **banco** rejeita a
violação — constraint sem teste é constraint que some num refactor de migration
sem ninguém perceber.

### `wallets`
`UNIQUE (player_id, currency)` · `CHECK (balance_amount >= 0)` ·
`CHECK (version >= 1)` · `CHECK (currency ~ '^[A-Z]{3}$')`

### `wager_transactions`
`UNIQUE (idempotency_key)` · `UNIQUE (provider_id, external_transaction_id)` ·
`CHECK (money_amount > 0)` · `CHECK` exigindo referência para `REFUND`/`ROLLBACK` ·
`CHECK` terminal tem `processed_at` · `CHECK` `REJECTED` tem `failure_code` ·
`CHECK` `observed_balance` é par (valor e moeda juntos ou nenhum)

**Índice único parcial impedindo dupla reversão:**

```sql
CREATE UNIQUE INDEX wager_transactions_single_reversal_uk
  ON wager_transactions (reference_transaction_id, kind)
  WHERE status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;
```

Parcial de propósito: uma tentativa `REJECTED` não deve bloquear a reversão
legítima seguinte. Há teste para os dois lados.

### `wallet_ledger_entries`
`UNIQUE (transaction_id, wallet_id)` — é esta constraint que torna o débito
duplicado **impossível** mesmo se dois processos passarem pela mesma transação
ao mesmo tempo.

**Aritmética verificada pelo banco:**

```sql
CHECK (balance_after = balance_before +
       CASE direction WHEN 'CREDIT' THEN money_amount ELSE -money_amount END)
```

Sem isso, um bug de mapeamento produziria ledger que não reconcilia, e a
divergência só apareceria muito depois, sem rastro da origem.

**Imutabilidade estrutural:** trigger `BEFORE UPDATE OR DELETE` com
`RAISE EXCEPTION`. Convenção de código não impede um `UPDATE` ad-hoc em
produção; a trigger sim.

### `inbox_messages`
`PRIMARY KEY (consumer_name, message_id)` — a dedup é **por consumidor**, não
global: dois consumidores precisam processar a mesma mensagem cada um a seu tempo.

A corrida entre duas entregas é decidida no banco (`ON CONFLICT DO NOTHING`), não
na entidade — mas o ciclo de vida de uma mensagem já reivindicada vive em
`InboxMessage`, com `receive`/`rehydrate` e `markProcessed` recusando marcação
dupla. A entidade é o que garante que "processada" seja um passo explícito
depois do efeito, e não um `UPDATE` solto no repositório.

---

## 9. Referências fora de ordem

`REFUND`/`ROLLBACK` cuja referência ainda não chegou vira `PENDING_REFERENCE`
(HTTP `202`) e é reprocessada pelo `PendingReferenceWorker`.

- Backoff exponencial `2^n` segundos, teto de **60s**, máximo de **8 tentativas**
  (~2 minutos de janela efetiva de espera acumulada).
- Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` e evento publicado. A
  transação não fica pendurada consumindo recurso, e o provedor recebe um
  veredicto.

**Justificativa dos números:** 8 tentativas com backoff exponencial cobrem
desordem realista de entrega (segundos a poucos minutos) sem segurar recurso
indefinidamente. Uma janela maior aumentaria a chance de resolver casos raros ao
custo de manter estado pendente por mais tempo; é um parâmetro de configuração
(`PENDING_REFERENCE_MAX_ATTEMPTS`), não uma constante.

### O claim NÃO é um lease — quem serializa é a wallet

`claimDuePendingReferences` usa `FOR UPDATE SKIP LOCKED`, mas o lock morre junto
com a transação do claim, que commita antes do trabalho começar. Não há
`locked_by`/`locked_until` como no outbox. **Então dois workers reivindicam a
mesma linha, e isso é esperado.**

O que garante a correção é o lock da wallet, e por isso a ordem dentro de
`retryOne` é rígida:

```
1. SELECT ... FOR UPDATE na wallet     ← o mutex
2. reler a transação                    ← só agora o estado é confiável
3. se não for mais PENDING_REFERENCE, sair
```

Inverter 1 e 2 parece equivalente e não é: os dois workers leriam
`PENDING_REFERENCE`, serializariam no lock da wallet, o vencedor processaria e o
**perdedor decidiria em cima de estado obsoleto**. Na prática ele resolvia a
referência de novo, via a reversão recém-criada pelo vencedor, levantava
`REFERENCE_ALREADY_REVERSED` e gravava `REJECTED` por cima de um `PROCESSED` que
já tinha lançado no ledger — produzindo uma transação `REJECTED` **com**
lançamento, que viola a regra 7.6 e faz o provedor concluir que o dinheiro não
voltou quando ele voltou.

Coberto por `test/concurrency/pendingReference.test.ts`, com 3 workers reais
disputando a mesma linha. O teste falha de forma determinística se a ordem for
invertida.

---

## 10. Autenticação — decisão consciente de NÃO implementar

A seção 2 declara que autenticação **não pontua** e não deve competir com
correção financeira, concorrência e idempotência. O trade-off foi feito de
propósito.

### Ponto de extensão explícito

| Artefato | Papel |
|---|---|
| `src/shared/http/AuthGuard.ts` | `AuthGuard` no-op registrado globalmente |
| `src/shared/http/Public.ts` | `@Public()` marcando health e `/metrics` |

### Desenho que seria adotado

Keycloak (ou Zitadel) no Docker Compose, OIDC:

1. extrair o Bearer token do header `Authorization`;
2. validar assinatura contra o JWKS do IdP, com cache de chaves e rotação;
3. conferir `issuer`, `audience` e expiração;
4. exigir o escopo da operação (`wagering:write`, `wallet:read`);
5. resolver a identidade do provedor e confrontá-la com o `providerId` do
   payload — um token do `provider-a` não pode submeter em nome do `provider-b`.

Sem tabela própria de usuários e sem hash de senha artesanal, como o enunciado
pede explicitamente.

### O que não muda

Mensagens da fila são canal interno confiável, mas **"canal confiável" não
significa "payload confiável"**. A identidade do provedor contida na mensagem
continua sujeita às mesmas validações de domínio: um `REFUND` do `provider-a`
não pode referenciar transação do `provider-b`, venha de onde vier. Isso é
verificado pelo `ReferenceResolver`, não pelo guard.

**Limitação:** sem autenticação, qualquer cliente com acesso de rede pode
submeter transações. Aceitável para o escopo do desafio e explicitamente
documentado.

---

## 11. Observabilidade

**Logs JSON** (pino) com `redact` estrutural. Campos redigidos: `money`,
`balance*`, `amount`, `payload`, `body`, `data`, `authorization`,
`idempotency-key`. Campos preservados: `correlationId`, `messageId`,
`transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`.

A redação é verificada por teste **na saída real do pino**, não na configuração:
o que importa é o que chega no stream. Sem esse teste, a redação vaza na
primeira linha de debug que alguém esquecer de remover.

`correlationId` propagado por `AsyncLocalStorage`, respeitando o header
`x-correlation-id` do provedor quando presente — assim o mesmo id atravessa API,
fila, outbox e worker.

**Métricas** em `/metrics` (Prometheus): `wager_transactions_total{kind,status}`,
`wager_duplicates_total{source}`, `wager_retries_total{reason}`,
`sqs_dlq_messages_total`, `wallet_lock_conflicts_total`, `outbox_pending_total`,
`outbox_lag_seconds`, `wager_processing_duration_seconds`,
`reconciliation_mismatch_total`.

Dois cuidados que valem registro:

- `wallet_lock_conflicts_total{operation}` é contada **dentro do
  `MikroOrmUnitOfWork`**, onde o SQLSTATE ainda existe (`40001` serialization,
  `40P01` deadlock, `55P03` lock_timeout). Um andar acima só resta a mensagem de
  erro, e classificar por `includes('lock')` erraria nos dois sentidos. Como o
  UoW é o mesmo para HTTP e SQS, a métrica cobre os dois caminhos.
- `wager_processing_duration_seconds{kind,source,outcome}` é observada em
  `try/finally` nos dois adapters, incluindo o caminho de exceção
  (`outcome="error"`): medir só o sucesso faria o p95 ignorar justamente as
  requisições lentas que falharam.

**Health checks** separados: `/health/live` não toca em dependência externa de
propósito. Se o Postgres cair, queremos a instância fora do balanceador
(readiness), não reiniciada em loop (liveness) — confundir os dois faz o
orquestrador reiniciar containers saudáveis durante uma indisponibilidade do
banco. Os probes de readiness rodam em paralelo, para o timeout não ser a soma
dos timeouts.

---

## 12. Reconciliação

`POST /wallets/:walletId/reconciliation` soma o ledger no banco e compara com o
saldo materializado. Divergências **não** são corrigidas silenciosamente: são
logadas em nível de erro, contabilizadas em `reconciliation_mismatch_total` e
sinalizadas com `consistent: false`.

Responde `200` mesmo quando inconsistente: a requisição de auditoria foi
atendida com sucesso — a divergência é o *conteúdo* da resposta, não uma falha
de processamento. Um `5xx` faria um monitor tratar como indisponibilidade do
endpoint em vez de alerta financeiro.

---

## 13. Diferencial: ledger de partidas dobradas

**Aditivo.** `wallet_ledger_entries` continua sendo a fonte da verdade do saldo,
com no máximo um lançamento por wallet por transação, exatamente como a seção
6.4 exige. O journal é uma segunda visão, contábil, gravada na mesma transação.

O que acrescenta: para toda movimentação existe uma **contrapartida explícita**.
Um `BET` de 25 não é só "-25 na wallet" — é 25 saindo de `PLAYER_LIABILITY` e
entrando em `HOUSE_REVENUE`. Responde à pergunta que o ledger simples não
responde: *de onde veio* e *para onde foi*.

`PLAYER_LIABILITY` é **passivo**: o saldo do jogador é dinheiro que a casa deve
a ele. Há um teste que verifica que o passivo total é exatamente a soma dos
saldos de todas as wallets.

A soma zero por journal é garantida por trigger
`CONSTRAINT ... DEFERRABLE INITIALLY DEFERRED` — roda no fim da transação,
quando todas as linhas já existem; verificar a cada `INSERT` reprovaria a
primeira perna de todo par válido.

---

## 14. Premissas adotadas

1. **Moeda única `BRL` nos cenários**, modelo multi-moeda preservado (permitido
   pela seção 6.1). Conflito de moeda é testado, e `UNIQUE (player_id, currency)`
   permite wallets do mesmo player em moedas diferentes.
2. **Reversão parcial fora de escopo** (seção 7.5): `REFUND`/`ROLLBACK` com valor
   diferente da referência são `REJECTED` com `REFERENCE_AMOUNT_MISMATCH`.
3. **`WIN` não exige referência.** Se vier com `referenceExternalTransactionId`,
   o campo é aceito e entra no `payloadHash`, mas não bloqueia o crédito.
4. **`WALLET_NOT_FOUND` é a única rejeição não persistida.**
   `wager_transactions.wallet_id` tem FK para `wallets`; uma transação órfã não
   poderia ser gravada, e não seria auditável de qualquer forma. Sai como `404`.
   Todas as demais rejeições — inclusive `WALLET_CURRENCY_MISMATCH` e
   `PLAYER_WALLET_MISMATCH` — **commitam** como `REJECTED` com evento
   `WagerTransactionRejected`, e o reenvio devolve o replay da rejeição.
5. **Eventos de integração vão para `wager-events.fifo`**, separada da fila de
   entrada.
6. **A wallet nasce com `version = 1`** e o lançamento `OPENING` registra a
   origem do saldo (`balanceBefore 0 → balanceAfter inicial`), como no exemplo
   de resposta da seção 9.
7. **`maxReceiveCount = 5`** antes da DLQ.

---

## 15. Limitações conhecidas

1. **Sem autenticação** (seção 10 deste documento).
2. **Sem OpenTelemetry.** Logs correlacionados e métricas Prometheus cobrem o
   mínimo da seção 12; tracing distribuído era opcional e não entrou.
3. **O teste de carga usou uma instância de API**, não três, e com
   durabilidade do Postgres desligada. Ver `docs/LOAD-TEST.md` para as seis
   limitações declaradas do experimento.
4. **Ponto de saturação não foi procurado.** Não sabemos onde o `lock_timeout`
   passa a disparar.
5. **A DLQ não tem consumidor.** Mensagens envenenadas ficam lá para
   investigação manual; um reprocessador de DLQ seria o próximo passo natural.
6. **`PurgeQueue` do MiniStack tem comportamento próprio** — os helpers de teste
   têm fallback de drenagem manual.
7. **Sem particionamento nem arquivamento do ledger.** Numa wallet com anos de
   histórico, `sumLedger` fica caro; a solução seria snapshot periódico de saldo
   com reconciliação incremental.
8. **O `AppConfig` é lido uma vez no boot.** Mudar configuração exige restart.

---

## 16. Onde os requisitos são atendidos

| Requisito | Onde |
|---|---|
| §5.1 sem `number` para dinheiro | `Money` sobre `decimal.js`, `numeric(20,2)`, lint proibindo `parseFloat`/`Number()` |
| §5.2 idempotência não em memória | `UNIQUE (idempotency_key)` + `inbox_messages` |
| §5.3 não confiar só em FIFO | dedup no banco; teste burla a dedup do broker de propósito |
| §5.4 não publicar antes do commit | outbox; teste sem worker prova `published_at` nulo |
| §5.5 não sobrescrever ledger | trigger `BEFORE UPDATE OR DELETE` |
| §5.6 sem lock global | lock por linha de wallet |
| §5.7 sem read-calculate-update solto | `FOR UPDATE` + `version` + `CHECK` |
| §5.8 múltiplas instâncias | 3 API + 2 workers no compose; testes de concorrência 1, 3 e 4 |
| §5.9 garantias no schema | seção 8 deste documento |
| §6 modelo de domínio | construtores privados + factories; `rehydrate` não revalida |
| §7 regras de negócio | `WagerRuleEngine` + `ReferenceResolver` |
| §8 cenário obrigatório | `test/concurrency/singleWallet.test.ts` |
| §9 API HTTP | 7 endpoints + mapeamento de status da seção 7 deste documento |
| §10 consumidor SQS | `WagerTransactionConsumer`, mesmo use case do HTTP |
| §11 outbox | `OutboxPublisherWorker` com `SKIP LOCKED` + lease |
| §12 observabilidade | seção 11 deste documento |
| §13 testes | `test/unit`, `test/integration`, `test/concurrency`; ver `README.md` |
