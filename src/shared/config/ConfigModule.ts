import { Global, Module } from '@nestjs/common';
import { AppConfig } from './AppConfig';

/**
 * Separado do SharedModule porque o PersistenceModule injeta AppConfig no
 * factory do MikroORM, quando o SharedModule ainda não terminou de montar.
 */
@Global()
@Module({
  providers: [AppConfig],
  exports: [AppConfig],
})
export class ConfigModule {}
