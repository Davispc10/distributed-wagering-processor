/**
 * Ciclo up → down → up. Um `down()` vazio passa despercebido em code review e
 * só aparece quando alguém precisa reverter em produção; aqui quebra o build.
 *
 * Uso: bun run migration:verify
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmConfig } from '@shared/persistence/mikroOrmConfig';

async function main(): Promise<void> {
  const orm = await MikroORM.init(buildMikroOrmConfig());
  const migrator = orm.getMigrator();

  try {
    const all = await migrator.getPendingMigrations();
    const alreadyApplied = await migrator.getExecutedMigrations();
    const total = all.length + alreadyApplied.length;

    if (total === 0) {
      console.log('\n  Nenhuma migration ainda — nada a verificar (esperado até a Fase 2).\n');
      return;
    }

    console.log(`\n  Verificando reversibilidade de ${String(total)} migration(s)\n`);

    const up1 = await migrator.up();
    console.log(`  ↑ up: ${String(up1.length)} aplicada(s)`);

    const down = await migrator.down({ to: 0 });
    console.log(`  ↓ down: ${String(down.length)} revertida(s)`);

    const remaining = await migrator.getExecutedMigrations();
    if (remaining.length > 0) {
      throw new Error(
        `down() não reverteu tudo: ${String(remaining.length)} migration(s) seguem aplicadas ` +
          `(${remaining.map((m) => m.name).join(', ')})`,
      );
    }

    const up2 = await migrator.up();
    console.log(`  ↑ up: ${String(up2.length)} reaplicada(s)`);

    if (up2.length !== total) {
      throw new Error(
        `reaplicação incompleta: esperado ${String(total)} migration(s), aplicou ${String(up2.length)}`,
      );
    }

    console.log('\n  OK — up → down → up limpo. Migrations são reversíveis.\n');
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(
    '\n  verify-migrations falhou:',
    error instanceof Error ? error.message : error,
    '\n',
  );
  process.exit(1);
});
