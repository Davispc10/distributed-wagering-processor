/**
 * Confere que as 3 APIs e os 2 workers respondem readiness: com uma instância
 * fora, os testes de concorrência mediriam menos paralelismo do que se imagina
 * e passariam por motivo errado.
 *
 * Uso: bun run verify:stack
 */
interface Target {
  name: string;
  url: string;
}

// Portas do host são configuráveis: colisão com outro projeto rodando na mesma
// máquina é comum, e não deveria exigir editar o compose.
const port = (envVar: string, fallback: number): number => Number(process.env[envVar] ?? fallback);

const TARGETS: Target[] = [
  { name: 'api-1', url: `http://localhost:${String(port('API_1_PORT', 3000))}/health/ready` },
  { name: 'api-2', url: `http://localhost:${String(port('API_2_PORT', 3001))}/health/ready` },
  { name: 'api-3', url: `http://localhost:${String(port('API_3_PORT', 3002))}/health/ready` },
  { name: 'worker-1', url: `http://localhost:${String(port('WORKER_1_PORT', 3100))}/health/ready` },
  { name: 'worker-2', url: `http://localhost:${String(port('WORKER_2_PORT', 3101))}/health/ready` },
];

const TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;

interface Check {
  target: Target;
  ok: boolean;
  detail: string;
}

async function probe(target: Target): Promise<Check> {
  try {
    const res = await fetch(target.url, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as {
      status?: string;
      checks?: { name: string; healthy: boolean }[];
    };

    if (!res.ok || body.status !== 'ready') {
      const failing = (body.checks ?? []).filter((c) => !c.healthy).map((c) => c.name);
      return {
        target,
        ok: false,
        detail: `HTTP ${String(res.status)}${failing.length > 0 ? ` — falhando: ${failing.join(', ')}` : ''}`,
      };
    }

    const deps = (body.checks ?? []).map((c) => c.name).join(', ');
    return { target, ok: true, detail: deps };
  } catch (error: unknown) {
    return { target, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  console.log(`\n  Verificando ${String(TARGETS.length)} instâncias (3 API + 2 worker)\n`);

  const deadline = Date.now() + TIMEOUT_MS;
  let checks: Check[] = [];

  for (;;) {
    checks = await Promise.all(TARGETS.map(probe));
    if (checks.every((c) => c.ok)) break;

    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.target.name.padEnd(9)} ${check.detail}`);
  }

  const down = checks.filter((c) => !c.ok);
  if (down.length > 0) {
    console.error(
      `\n  ${String(down.length)} instância(s) não ficaram prontas em ${String(TIMEOUT_MS / 1000)}s.` +
        `\n  Verifique com: docker compose ps && docker compose logs --tail=50\n`,
    );
    process.exit(1);
  }

  console.log('\n  OK — stack multi-instância saudável.\n');
}

main().catch((error: unknown) => {
  console.error('\n  verify-stack falhou:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
