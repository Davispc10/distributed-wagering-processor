# Teste de carga

Diferencial opcional (seção 14). Não há meta de RPS — o que este documento
tenta entregar é um experimento honesto e uma leitura franca dos números.

Reproduzir: `bun run test:load`.

## Em uma linha

**182 req/s, p50 145 ms, p95 314 ms, 0% de erro** — com durabilidade do
PostgreSQL **ligada**, que é como a stack do `bun run infra:up` roda.

O mesmo código com `fsync=off` e dados em tmpfs entrega 715 req/s. As duas
corridas estão registradas abaixo de propósito: a diferença entre elas é o que
o experimento realmente descobriu — **durabilidade custa ~3.9× de throughput, e
é o fator dominante, não o esquema de locking**.

Se for citar um número só, cite **182 req/s**.

---

## Ambiente

Foram **duas corridas em ambientes diferentes**, e a diferença entre elas é o
resultado mais interessante deste documento.

| Item | Corrida A | Corrida B |
|---|---|---|
| Data | — | 2026-08-13 |
| Alvo | `docker-compose.test.yml` | `docker-compose.yml` (a stack do `infra:up`) |
| PostgreSQL | `fsync=off`, `synchronous_commit=off`, dados em **tmpfs** | **padrão — durabilidade ligada**, dados em volume |
| Instâncias | 1 API + 1 worker, no **host** | 3 APIs + 2 workers, em **Docker** |
| Tráfego | a única API | só `api-1:3000` (sem balanceador) |
| Duração | 20s por cenário | 30s por cenário (default atual do script) |
| Runtime | Bun 1.3.13 | Bun 1.3.14 |
| SQS | MiniStack (`ministackorg/ministack`) em Docker | idem |
| Pool de conexões | min 2 / max 20 | idem |
| Gerador de carga | k6, no **mesmo host** | k6 1.4.0, no **mesmo host** |

**A configuração da corrida A é de teste, não de produção.** `fsync=off` e
`synchronous_commit=off` removem o custo de durabilidade em disco, que num
ambiente real é justamente o componente dominante da latência de commit. Ela é o
**teto** da stack. A corrida B é o que `bun run test:load` produz por padrão,
contra a stack que o `bun run infra:up` sobe.

Rodar o gerador de carga na mesma máquina que o sistema sob teste distorce as
duas: os dois disputam CPU. Um experimento mais rigoroso separaria as máquinas.

---

## Metodologia

Dois cenários sequenciais, `constant-vus`, 20s cada:

| Cenário | VUs | O que mede |
|---|---|---|
| `hot_wallet` | 20 | Todo o tráfego numa **única** wallet. Contenção máxima no lock pessimista. |
| `spread_wallets` | 40 | Tráfego distribuído entre 20 wallets. Throughput sem contenção. |

A comparação entre os dois é o ponto do experimento: **quanto custa serializar
por wallet?**

Todas as operações são `BET` de `1.00 BRL`, contra wallets abertas com
`10000000.00 BRL` — saldo alto de propósito, para medir throughput em vez da
velocidade com que o saldo acaba (o caminho de saldo insuficiente já é coberto
pelos testes de concorrência).

Depois da carga, o script coleta `/metrics` e verifica a invariante
`saldo == ledger reconstruído` em todas as wallets tocadas. Medir throughput
sem verificar correção mediria a velocidade com que se corrompe dado.

---

## Resultado B — o número desta stack

**É o que `bun run test:load` produz contra a stack do `bun run infra:up`.**

```
requisições           10980
throughput            182.65 req/s

latência p50          144.72 ms
latência p95          313.61 ms
latência p99          497.59 ms

hot wallet   p50/p95/p99   129.93 / 277.89 / 434.01 ms
spread       p50/p95/p99   155.07 / 333.68 / 521.34 ms

taxa de erro          0.000 %
falhas transitórias   0
conflitos idempot.    0
rejeições por saldo   0
```

Métricas do servidor ao fim da carga (deltas da corrida):

```
wager_transactions_total{kind="BET",status="PROCESSED"}   +10980
outbox_lag_seconds                                        0
outbox_pending_total                                      0
wallet_lock_conflicts_total                               (ausente — nenhum conflito)
```

Invariante verificada em 20/20 wallets.

---

## Resultado A — o mesmo código com durabilidade desligada

Existe só para comparação: é o **teto do código** quando o disco sai da conta.
Não é reproduzível por `bun run test:load` sem apontar para o
`docker-compose.test.yml`. **Não cite este número isolado** — ele mede a stack de
teste, não a de execução.

```
requisições           28648
throughput            715.71 req/s

latência p50          38.83 ms
latência p95          61.90 ms
latência p99          89.48 ms

hot wallet   p50/p95/p99   53.30 / 86.45 / 100.87 ms
spread       p50/p95/p99   35.10 / 53.96 /  66.73 ms

taxa de erro          0.000 %
falhas transitórias   0
conflitos idempot.    0
rejeições por saldo   0
```

Métricas do servidor ao fim da carga:

```
wager_transactions_total{kind="BET",status="PROCESSED"}   28648
outbox_lag_seconds                                        0
outbox_pending_total                                      0
wallet_lock_conflicts_total                               (ausente — nenhum conflito)
```

Invariante verificada em 20/20 wallets.

---

## Análise

### O que a durabilidade custa — A contra B

A limitação #2 da versão anterior deste documento era uma hipótese: *"com
`fsync=on` a latência de commit subiria de forma significativa, e o throughput
cairia na mesma proporção"*. A corrida B mediu.

| | A (`fsync=off`, tmpfs) | B (durável, volume) | Fator |
|---|---|---|---|
| throughput | 715.71 req/s | 182.65 req/s | **3.9× menor** |
| p50 | 38.83 ms | 144.72 ms | 3.7× maior |
| p95 | 61.90 ms | 313.61 ms | 5.1× maior |
| p99 | 89.48 ms | 497.59 ms | 5.6× maior |

A hipótese se confirmou, e a proporção é quase exata: throughput cai ~3.9× e o
p50 sobe ~3.7×. **Toda a diferença é custo de commit durável**, não de código —
o caminho executado é idêntico nas duas.

Isso muda qual número citar. **182 req/s é o número honesto para uma stack com
durabilidade ligada**; 715 req/s é o teto do código quando o disco sai da conta.
A corrida B ainda é otimista: um único nó de Postgres, sem réplica síncrona.

### O lock por wallet deixa de ser o gargalo quando o fsync entra

Na corrida A, hot wallet era **mais lento** que spread (p95 86 vs 54 ms) — o
lock pessimista aparecendo. Na corrida B a ordem inverte: hot p95 278 ms contra
spread 334 ms.

Cuidado ao ler isso: os dois cenários **não são diretamente comparáveis**, porque
`spread` roda com 40 VUs e `hot` com 20. O que a inversão mostra não é que o lock
ficou mais barato, e sim que ele **parou de ser o componente dominante**: com
commit durável, o custo de esperar o disco supera o custo de esperar a fila do
lock, e dobrar a concorrência (spread) pesa mais do que serializar na mesma linha
(hot). O penalty de ~1.6× medido em A não reaparece em B.

Consequência prática: otimizar o esquema de locking só compensa depois de
resolver a durabilidade. Trocar pessimista por otimista aqui não moveria o
ponteiro.

### O outbox acompanha nos dois regimes

`outbox_lag_seconds = 0` e `outbox_pending_total = 0` ao fim das duas corridas —
em B com **2 workers** drenando ~22 mil eventos (dois por transação) enquanto a
ingestão acontecia. É o resultado que mais se sustenta entre ambientes: o
transactional outbox não vira gargalo nem acumula backlog sob carga sustentada.

### Zero erros em ambos

Nenhuma requisição atingiu o `lock_timeout` de 3s, nem em A nem em B, mesmo com
a latência de commit 3.7× maior. O ponto de saturação está acima de 20 VUs numa
única wallet — e continua não tendo sido procurado.

**Zero conflitos de idempotência** porque cada VU gera chaves únicas. O caminho
de replay tem custo diferente (é uma leitura a mais e nenhuma escrita) e não foi
medido separadamente.

---

## Análise original da corrida A

**O custo da serialização por wallet é ~1.6× na latência.** Hot wallet p95 de
86ms contra 54ms distribuído. Isso é o lock pessimista fazendo exatamente o que
deveria: 20 VUs disputando a mesma linha se enfileiram, e cada uma espera a
anterior commitar. O p99 de 101ms mostra que a cauda continua controlada — não
há retry storm, porque não há retry: a fila do lock é justa e finita.

Se tivéssemos escolhido optimistic locking, este cenário produziria conflitos e
retries, e o p99 explodiria bem antes de 100ms. É a justificativa empírica da
decisão registrada no `ARCHITECTURE.md`.

**Zero falhas transitórias.** Nenhuma requisição atingiu o `lock_timeout` de 3s,
o que indica que 20 VUs numa única wallet ainda estão confortavelmente dentro da
capacidade. O ponto de saturação está acima disso — não foi procurado.

**`outbox_lag_seconds = 0` e `outbox_pending_total = 0`.** O publisher drenou
~57 mil eventos (dois por transação) acompanhando o ritmo da ingestão, com um
único worker.

---

## Limitações conhecidas

1. **Nenhuma das corridas mede throughput agregado com balanceamento.** A
   corrida A tinha uma API só; a B tem três no ar, mas todo o tráfego vai para
   `api-1` — não há balanceador na frente. O ganho de escalar horizontalmente
   não foi medido em nenhuma das duas.
2. ~~Durabilidade desligada no Postgres.~~ **Medido na corrida B:** 3.9× menos
   throughput, p50 3.7× maior. Continua valendo que nem A nem B têm réplica
   síncrona, que custaria mais ainda.
3. **Gerador de carga no mesmo host** — disputa de CPU distorce os números para
   baixo de forma não quantificada. Pesa mais em B, onde 5 containers da
   aplicação disputam CPU com o k6.
4. **20s (A) e 30s (B) por cenário** são curtos para observar degradação por
   acúmulo (bloat de índice, crescimento da outbox, pressão de vacuum). Um teste
   de soak de horas diria coisas que este não diz.
5. **Ponto de saturação não foi procurado.** Não sabemos onde a latência começa
   a crescer de forma não-linear nem onde o `lock_timeout` passa a disparar.
6. **Só `BET`.** `REFUND` e `ROLLBACK` fazem uma resolução de referência a mais
   e teriam latência maior; não foram medidos.
7. **`hot` e `spread` têm VUs diferentes** (20 vs 40), então a comparação direta
   entre os dois cenários mistura contenção de lock com nível de concorrência.
   Igualar os VUs isolaria o efeito do lock — não foi feito.

O número honesto a levar daqui não é "715 req/s" nem "182 req/s". É:

- **durabilidade custa ~3.9× de throughput** — e é o fator dominante, não o
  esquema de locking;
- **o outbox acompanha a ingestão sem acumular backlog** nos dois regimes;
- **zero erros e zero `lock_timeout`** em ambos, com a invariante
  `saldo == ledger` verificada ao fim de cada corrida.
