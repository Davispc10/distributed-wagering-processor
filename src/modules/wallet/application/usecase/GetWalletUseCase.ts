import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import type { Wallet } from '@modules/wallet/domain/Wallet';
import {
  WALLET_REPOSITORY,
  type LedgerPage,
  type WalletRepository,
} from '@modules/wallet/application/port/WalletRepository';

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new BusinessRuleError(FailureCode.WalletNotFound, `wallet ${walletId} não encontrada`);
    }
    return wallet;
  }
}

export interface ListWalletLedgerInput {
  walletId: string;
  limit: number;
  cursor?: string;
}

@Injectable()
export class ListWalletLedgerUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}

  async execute(input: ListWalletLedgerInput): Promise<LedgerPage> {
    const wallet = await this.wallets.findById(input.walletId);
    if (!wallet) {
      throw new BusinessRuleError(
        FailureCode.WalletNotFound,
        `wallet ${input.walletId} não encontrada`,
      );
    }

    return this.wallets.listLedger({
      walletId: input.walletId,
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
  }
}
