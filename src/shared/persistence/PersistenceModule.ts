import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { ConfigModule } from '@shared/config/ConfigModule';
import { buildMikroOrmConfig } from './mikroOrmConfig';

/**
 * Não exporta nada: o `MikroOrmCoreModule` criado por `forRootAsync` já é
 * `@Global()`, então `EntityManager` e `MikroORM` ficam injetáveis em qualquer
 * módulo sem reexportação.
 */
@Module({
  imports: [
    ConfigModule,
    MikroOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: AppConfig) => buildMikroOrmConfig(config),
      inject: [AppConfig],
    }),
  ],
})
export class PersistenceModule {}
