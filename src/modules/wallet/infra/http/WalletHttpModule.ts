import { Module } from '@nestjs/common';
import { WalletModule } from '@modules/wallet/WalletModule';
import { WalletController } from './WalletController';

@Module({
  imports: [WalletModule],
  controllers: [WalletController],
})
export class WalletHttpModule {}
