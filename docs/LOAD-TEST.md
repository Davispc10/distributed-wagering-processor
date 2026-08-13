# Teste de carga

Diferencial opcional (seção 14). Não há meta de RPS — o que este documento
tenta entregar é um experimento honesto e uma leitura franca dos números.

Reproduzir: `bun run test:load`.

---

## Ambiente

| Item | Valor |
|---|---|
| Runtime | Bun 1.3.13 |
| PostgreSQL | 16-alpine em Docker, `fsync=off`, `synchronous_commit=off`, `max_connections=300`, dados em tmpfs |
| SQS | MiniStack (`ministackorg/ministack`) em Docker |
| Instâncias | **1 API + 1 worker**, ambas no host |
| Pool de conexões | min 2 / max 20 |
| Gerador de carga | k6 0.5x, no **mesmo host** |

**A configuração do Postgres é de teste, não de produção.** `fsync=off` e
`synchronous_commit=off` removem o custo de durabilidade em disco, que num
ambiente real é justamente o componente dominante da latência de commit. Os
números abaixo são o **teto** da stack, não uma projeção de produção.

Rodar o gerador de carga na mesma máquina que o sistema sob teste também
distorce: os dois disputam CPU. Um experimento mais rigoroso separaria as
máquinas.

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

## Resultado

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
único worker. O lag zero ao final é o número que mais importa aqui: significa
que o transactional outbox não vira gargalo nem acumula backlog sob carga
sustentada.

**Zero conflitos de idempotência** porque cada VU gera chaves únicas. O caminho
de replay tem custo diferente (é uma leitura a mais e nenhuma escrita) e não foi
medido separadamente.

---

## Limitações conhecidas

1. **Uma instância de API**, não três. O compose sobe três; a medição usou uma
   para isolar a latência do caminho crítico do balanceamento entre processos.
   O throughput agregado com três instâncias não foi medido.
2. **Durabilidade desligada no Postgres.** Com `fsync=on` a latência de commit
   subiria de forma significativa, e o throughput cairia na mesma proporção.
3. **Gerador de carga no mesmo host** — disputa de CPU distorce os números para
   baixo de forma não quantificada.
4. **20s por cenário** é curto para observar degradação por acúmulo (bloat de
   índice, crescimento da outbox, pressão de vacuum). Um teste de soak de horas
   diria coisas que este não diz.
5. **Ponto de saturação não foi procurado.** Não sabemos onde a latência começa
   a crescer de forma não-linear nem onde o `lock_timeout` passa a disparar.
6. **Só `BET`.** `REFUND` e `ROLLBACK` fazem uma resolução de referência a mais
   e teriam latência maior; não foram medidos.

O número honesto a levar daqui não é "715 req/s" — é "**serializar por wallet
custa ~1.6× de latência no p95, e o outbox acompanha sem acumular backlog**".
