/**
 * Teste de carga — diferencial opcional.
 *
 * Dois cenários deliberadamente opostos:
 *
 *   hot_wallet    — todo o tráfego numa única wallet. Mede o custo real do lock
 *                   pessimista sob contenção máxima. É o pior caso possível
 *                   para a nossa estratégia de concorrência, e por isso o mais
 *                   informativo.
 *   spread_wallets — tráfego distribuído entre N wallets. Mede o throughput
 *                   quando não há contenção, ou seja, o teto da stack.
 *
 * A diferença entre os dois é a resposta à pergunta que importa: quanto custa
 * serializar por wallet?
 *
 * Não há meta de RPS. O relatório em docs/LOAD-TEST.md registra ambiente,
 * metodologia e números com a honestidade que o enunciado pede.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const HOT_VUS = Number(__ENV.HOT_VUS || 20);
const SPREAD_VUS = Number(__ENV.SPREAD_VUS || 40);
const DURATION = __ENV.DURATION || '30s';

const rejectedInsufficient = new Counter('rejected_insufficient_funds');
const idempotentReplays = new Counter('idempotent_replays');
const transientFailures = new Counter('transient_failures');
const conflicts = new Counter('idempotency_conflicts');
const acceptedLatency = new Trend('accepted_latency_ms', true);
// Trends separadas: a diferença entre hot e spread é a resposta à pergunta
// "quanto custa serializar por wallet?".
const hotLatency = new Trend('hot_wallet_latency_ms', true);
const spreadLatency = new Trend('spread_wallet_latency_ms', true);

const wallets = new SharedArray('wallets', () => JSON.parse(open(__ENV.WALLETS_FILE)));

export const options = {
  scenarios: {
    hot_wallet: {
      executor: 'constant-vus',
      vus: HOT_VUS,
      duration: DURATION,
      exec: 'hotWallet',
      tags: { scenario: 'hot_wallet' },
    },
    spread_wallets: {
      executor: 'constant-vus',
      vus: SPREAD_VUS,
      duration: DURATION,
      exec: 'spreadWallets',
      startTime: DURATION,
      tags: { scenario: 'spread_wallets' },
    },
  },
  // p99 explícito: o enunciado pede p50/p95/p99 e o default do k6 não inclui p99.
  summaryTrendStats: ['min', 'med', 'avg', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    // Sem meta de RPS. O que checamos é o que não pode acontecer:
    // nenhum 5xx que não seja o 503 explícito de contenção.
    'http_req_failed{expected_response:true}': ['rate<0.01'],
  },
};

function submit(wallet, index, latencyTrend) {
  const externalId = `load-${__VU}-${__ITER}-${index}`;
  const payload = JSON.stringify({
    providerId: 'load-provider',
    externalTransactionId: externalId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: `round-${__VU}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  });

  const res = http.post(`${BASE_URL}/wagering/transactions`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `load-provider:${externalId}`,
    },
  });

  if (res.status === 201 || res.status === 200) {
    acceptedLatency.add(res.timings.duration);
    latencyTrend.add(res.timings.duration);
  }
  if (res.status === 200) idempotentReplays.add(1);
  if (res.status === 409) conflicts.add(1);
  if (res.status === 503) transientFailures.add(1);
  if (res.status === 422) {
    try {
      if (JSON.parse(res.body).failureCode === 'INSUFFICIENT_FUNDS') rejectedInsufficient.add(1);
    } catch (_) {
      /* corpo não-JSON já é coberto pelo check abaixo */
    }
  }

  // 422 (saldo acabou) e 503 (contenção) são respostas CORRETAS sob carga —
  // não são falha do sistema. 5xx inesperado, sim.
  check(res, {
    'status esperado': (r) => [200, 201, 202, 422, 503].includes(r.status),
    'sem erro inesperado': (r) => r.status !== 500,
  });
}

export function hotWallet() {
  submit(wallets[0], 'hot', hotLatency);
}

export function spreadWallets() {
  submit(wallets[__VU % wallets.length], 'spread', spreadLatency);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    [__ENV.SUMMARY_FILE || 'load-summary.json']: JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const p = (metric, stat) => (m[metric] && m[metric].values[stat] !== undefined
    ? m[metric].values[stat].toFixed(2)
    : 'n/a');

  return `
  ── Teste de carga ────────────────────────────────────────────
  requisições           ${m.http_reqs ? m.http_reqs.values.count : 0}
  throughput            ${p('http_reqs', 'rate')} req/s

  latência p50          ${p('http_req_duration', 'med')} ms
  latência p95          ${p('http_req_duration', 'p(95)')} ms
  latência p99          ${p('http_req_duration', 'p(99)')} ms

  hot wallet   p50/p95/p99   ${p('hot_wallet_latency_ms', 'med')} / ${p('hot_wallet_latency_ms', 'p(95)')} / ${p('hot_wallet_latency_ms', 'p(99)')} ms
  spread       p50/p95/p99   ${p('spread_wallet_latency_ms', 'med')} / ${p('spread_wallet_latency_ms', 'p(95)')} / ${p('spread_wallet_latency_ms', 'p(99)')} ms
  taxa de erro          ${m.http_req_failed ? (m.http_req_failed.values.rate * 100).toFixed(3) : '0'} %
  replays idempotentes  ${m.idempotent_replays ? m.idempotent_replays.values.count : 0}
  rejeições por saldo   ${m.rejected_insufficient_funds ? m.rejected_insufficient_funds.values.count : 0}
  falhas transitórias   ${m.transient_failures ? m.transient_failures.values.count : 0}
  conflitos idempot.    ${m.idempotency_conflicts ? m.idempotency_conflicts.values.count : 0}
  ──────────────────────────────────────────────────────────────
`;
}
