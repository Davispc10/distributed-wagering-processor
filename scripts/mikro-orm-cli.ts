/**
 * Usa a API do Migrator em vez do binário `mikro-orm`, cuja resolução própria
 * de config e módulos briga com o Bun.
 *
 * Uso:
 *   bun scripts/mikro-orm-cli.ts migration:up
 *   bun scripts/mikro-orm-cli.ts migration:down
 *   bun scripts/mikro-orm-cli.ts migration:list
 *   bun scripts/mikro-orm-cli.ts migration:create NomeDaMigration
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmConfig } from '@shared/persistence/mikroOrmConfig';

type Command = 'migration:up' | 'migration:down' | 'migration:list' | 'migration:create';

const COMMANDS: Command[] = [
  'migration:up',
  'migration:down',
  'migration:list',
  'migration:create',
];

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  const arg = process.argv[3];

  if (!command || !COMMANDS.includes(command)) {
    console.error(`\n  Comando inválido. Use um de: ${COMMANDS.join(', ')}\n`);
    process.exit(1);
  }

  const orm = await MikroORM.init(buildMikroOrmConfig());
  const migrator = orm.getMigrator();

  try {
    switch (command) {
      case 'migration:up': {
        const applied = await migrator.up();
        if (applied.length === 0) {
          console.log('  Nenhuma migration pendente.');
        } else {
          for (const m of applied) console.log(`  ↑ ${m.name}`);
        }
        break;
      }

      case 'migration:down': {
        const reverted = await migrator.down();
        if (reverted.length === 0) {
          console.log('  Nenhuma migration para reverter.');
        } else {
          for (const m of reverted) console.log(`  ↓ ${m.name}`);
        }
        break;
      }

      case 'migration:list': {
        const executed = await migrator.getExecutedMigrations();
        const pending = await migrator.getPendingMigrations();
        console.log(`\n  Aplicadas (${String(executed.length)}):`);
        for (const m of executed) console.log(`    ✓ ${m.name}`);
        console.log(`\n  Pendentes (${String(pending.length)}):`);
        for (const m of pending) console.log(`    · ${m.name}`);
        console.log();
        break;
      }

      case 'migration:create': {
        // `blank: true`: CHECK, trigger e índice parcial não saem de schema diff.
        const result = await migrator.createMigration(undefined, true, false, arg);
        console.log(`  + ${result.fileName}`);
        console.log(
          '    Migration em branco. Escreva up() E down() — down vazio não é reversível.',
        );
        break;
      }
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error('\n  migration falhou:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
