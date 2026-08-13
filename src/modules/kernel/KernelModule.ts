import { Global, Module } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, SystemClock, UuidV7Generator } from '@shared/Clock';
import { MikroOrmUnitOfWork, UNIT_OF_WORK } from '@shared/persistence/UnitOfWork';
import { PayloadHasher } from './application/PayloadHasher';

/** `Clock` e `IdGenerator` são ports para os testes de backoff controlarem o tempo. */
@Global()
@Module({
  providers: [
    PayloadHasher,
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
  ],
  exports: [PayloadHasher, CLOCK, ID_GENERATOR, UNIT_OF_WORK],
})
export class KernelModule {}
