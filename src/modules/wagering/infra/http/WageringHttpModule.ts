import { Module } from '@nestjs/common';
import { WageringModule } from '@modules/wagering/WageringModule';
import { WageringController } from './WageringController';

@Module({
  imports: [WageringModule],
  controllers: [WageringController],
})
export class WageringHttpModule {}
