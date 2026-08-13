import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type EntitySchema } from '@mikro-orm/postgresql';
import { AppConfig } from '@shared/config/AppConfig';
import { InboxMessageSchema } from '@modules/messaging/infra/persistence/model/InboxMessageModel';
import { OutboxMessageSchema } from '@modules/messaging/infra/persistence/model/OutboxMessageModel';
import { WagerTransactionSchema } from '@modules/wagering/infra/persistence/model/WagerTransactionModel';
import { WalletLedgerEntrySchema } from '@modules/wallet/infra/persistence/model/WalletLedgerEntryModel';
import { WalletSchema } from '@modules/wallet/infra/persistence/model/WalletModel';

/**
 * Cada módulo declara o mapeamento das suas tabelas; aqui é só o ponto de
 * registro, porque o MikroORM precisa de todas as entidades num único `init`.
 *
 * Structs anêmicas com `EntitySchema` em vez de decorators: mantém o mapeamento
 * fora da classe, impedindo o atalho de usar a entidade ORM como entidade de
 * domínio, e dispensa `emitDecoratorMetadata` sob Bun.
 */
export const ENTITY_SCHEMAS: EntitySchema[] = [
  WalletSchema,
  WalletLedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];

export function buildMikroOrmConfig(
  config: AppConfig = new AppConfig(),
): ReturnType<typeof defineConfig> {
  const pg = config.postgres;

  return defineConfig({
    host: pg.host,
    port: pg.port,
    dbName: pg.dbName,
    user: pg.user,
    password: pg.password,
    entities: ENTITY_SCHEMAS,
    discovery: { warnWhenNoEntities: false },
    pool: { min: pg.poolMin, max: pg.poolMax },
    debug: config.env.NODE_ENV === 'development' && config.env.LOG_LEVEL === 'debug',

    // Contenção numa wallet quente vira erro retentável, não uma requisição
    // pendurada segurando o lock e travando a fila daquela wallet.
    driverOptions: {
      connection: {
        options: `-c lock_timeout=${String(pg.lockTimeoutMs)}ms -c statement_timeout=${String(pg.statementTimeoutMs)}ms`,
      },
    },

    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: './src/shared/persistence/migrations',
      glob: '!(*.d).{js,ts}',
      transactional: true,
      disableForeignKeys: false,
      allOrNothing: true,
      // Migrations à mão: CHECK, trigger e índice parcial não saem de schema diff.
      snapshot: false,
      emit: 'ts',
    },
  });
}

export default buildMikroOrmConfig();
