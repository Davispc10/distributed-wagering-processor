import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from '@shared/http/ZodValidationPipe';
import { CorrelationContext } from '@shared/observability/CorrelationContext';
import {
  ledgerQuerySchema,
  openWalletSchema,
  toMoney,
  type LedgerQueryParams,
  type OpenWalletBody,
} from '@modules/wagering/infra/http/schema/wageringSchema';
import {
  GetWalletUseCase,
  ListWalletLedgerUseCase,
} from '@modules/wallet/application/usecase/GetWalletUseCase';
import { OpenWalletUseCase } from '@modules/wallet/application/usecase/OpenWalletUseCase';
import { ReconcileWalletUseCase } from '@modules/wallet/application/usecase/ReconcileWalletUseCase';
import type { Wallet } from '@modules/wallet/domain/Wallet';

interface MoneyResponse {
  amount: string;
  currency: string;
}

interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyResponse;
  version: number;
}

interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyResponse;
  balanceBefore: MoneyResponse;
  balanceAfter: MoneyResponse;
  createdAt: string;
}

interface LedgerResponse {
  entries: LedgerEntryResponse[];
  nextCursor?: string;
}

interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyResponse;
  calculatedBalance: MoneyResponse;
  difference: MoneyResponse;
  consistent: boolean;
  checkedEntries: number;
}

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @UsePipes(new ZodValidationPipe(openWalletSchema))
  async create(@Body() body: OpenWalletBody): Promise<WalletResponse> {
    const correlationId = CorrelationContext.correlationId ?? CorrelationContext.newCorrelationId();

    const { wallet } = await this.openWallet.execute({
      playerId: body.playerId,
      initialBalance: toMoney(body.initialBalance),
      correlationId,
    });

    return this.toWalletResponse(wallet);
  }

  @Get(':walletId')
  async findOne(
    @Param('walletId', new ParseUUIDPipe({ version: '7' })) walletId: string,
  ): Promise<WalletResponse> {
    return this.toWalletResponse(await this.getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe({ version: '7' })) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQueryParams,
  ): Promise<LedgerResponse> {
    const page = await this.listLedger.execute({
      walletId,
      limit: query.limit,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });

    return {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * `200` mesmo inconsistente: a divergência é o conteúdo da resposta, não uma
   * falha. Um 5xx faria o monitor tratar como endpoint fora do ar.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(
    @Param('walletId', new ParseUUIDPipe({ version: '7' })) walletId: string,
  ): Promise<ReconciliationResponse> {
    const result = await this.reconcile.execute(walletId);

    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }

  private toWalletResponse(wallet: Wallet): WalletResponse {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
