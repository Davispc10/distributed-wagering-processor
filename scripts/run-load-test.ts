/**
 * Prepara as wallets, roda o k6, coleta as métricas do servidor e verifica a
 * invariante `saldo == ledger`. Medir throughput sem verificar correção mediria
 * a velocidade com que se corrompe dado.
 *
 * Uso: bun run test:load
 */
import { $ } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmConfig } from '@shared/persistence/mikroOrmConfig';
import { AppConfig } from '@shared/config/AppConfig';
import { loadEnv } from '@shared/config/env';

const BASE_URL = process.env['LOAD_BASE_URL'] ?? 'http://localhost:3000';
const WALLET_COUNT = Number(process.env['LOAD_WALLETS'] ?? 20);
const WALLETS_FILE = '/tmp/wagering-load-wallets.json';
const SUMMARY_FILE = process.env['LOAD_SUMMARY'] ?? '/tmp/wagering-load-summary.json';

interface WalletRef {
  walletId: string;
  playerId: string;
}

async function createWallets(): Promise<WalletRef[]> {
  const wallets: WalletRef[] = [];

  for (let i = 0; i < WALLET_COUNT; i++) {
    const playerId = crypto.randomUUID();
    const res = await fetch(`${BASE_URL}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        // Saldo alto para medir throughput, não a velocidade com que o saldo acaba.
        initialBalance: { amount: '10000000.00', currency: 'BRL' },
      }),
    });

    if (!res.ok) throw new Error(`falha ao criar wallet ${String(i)}: HTTP ${String(res.status)}`);
    const body = (await res.json()) as { id: string };
    wallets.push({ walletId: body.id, playerId });
  }

  return wallets;
}

async function collectServerMetrics(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE_URL}/metrics`);
  const text = await res.text();
  const wanted = [
    'outbox_lag_seconds',
    'outbox_pending_total',
    'wallet_lock_conflicts_total',
    'wager_duplicates_total',
    'wager_retries_total',
    'wager_transactions_total',
  ];

  const collected: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const name = line.split(/[\s{]/)[0];
    if (name !== undefined && wanted.includes(name)) {
      collected[line.slice(0, line.lastIndexOf(' '))] = line.slice(line.lastIndexOf(' ') + 1);
    }
  }
  return collected;
}

async function verifyInvariant(walletIds: string[]): Promise<void> {
  const orm = await MikroORM.init({
    ...buildMikroOrmConfig(new AppConfig(loadEnv(process.env))),
    allowGlobalContext: true,
  });

  try {
    const rows = await orm.em
      .getConnection()
      .execute<{ id: string; stored: string; calculated: string }[]>(
        `SELECT w.id,
              w.balance_amount::text AS stored,
              COALESCE((SELECT SUM(CASE l.direction WHEN 'CREDIT' THEN l.money_amount ELSE -l.money_amount END)
                          FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)::text AS calculated
         FROM wallets w
        WHERE w.id = ANY(string_to_array(?, ',')::uuid[])`,
        [walletIds.join(',')],
      );

    const broken = rows.filter((r) => Number(r.stored) !== Number(r.calculated));
    if (broken.length > 0) {
      console.error('\n  INVARIANTE VIOLADA SOB CARGA:');
      for (const row of broken) {
        console.error(`  ! ${row.id}: saldo ${row.stored} != ledger ${row.calculated}`);
      }
      process.exit(1);
    }

    console.log(`\n  ✓ invariante saldo == ledger verificada em ${String(rows.length)} wallets`);
  } finally {
    await orm.close(true);
  }
}

async function main(): Promise<void> {
  const k6 = await $`which k6`.nothrow().quiet();
  if (k6.exitCode !== 0) {
    console.error('\n  k6 não encontrado. Instale com: brew install k6\n');
    process.exit(1);
  }

  console.log(`\n  Preparando ${String(WALLET_COUNT)} wallets em ${BASE_URL}...`);
  const wallets = await createWallets();
  await Bun.write(WALLETS_FILE, JSON.stringify(wallets));

  const before = await collectServerMetrics();

  console.log('  Rodando k6 (hot_wallet e spread_wallets)...\n');
  await $`k6 run test/load/wagering.k6.js`.env({
    ...process.env,
    BASE_URL,
    WALLETS_FILE,
    SUMMARY_FILE,
  });

  // Dá tempo do publisher drenar o que a carga gerou antes de medir o lag.
  await Bun.sleep(3_000);
  const after = await collectServerMetrics();

  console.log('\n  ── Métricas do servidor ──────────────────────────────────────');
  for (const [key, value] of Object.entries(after)) {
    const previous = before[key];
    const delta = previous !== undefined ? Number(value) - Number(previous) : Number(value);
    console.log(`  ${key.padEnd(58)} ${value}  (Δ ${String(delta)})`);
  }
  console.log('  ──────────────────────────────────────────────────────────────');

  await verifyInvariant(wallets.map((w) => w.walletId));

  console.log(`\n  Resumo do k6 em ${SUMMARY_FILE}`);
  console.log('  Registre ambiente, metodologia e números em docs/LOAD-TEST.md\n');
}

main().catch((error: unknown) => {
  console.error('\n  teste de carga falhou:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
