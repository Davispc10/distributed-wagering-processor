import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UsePipes,
} from '@nestjs/common';
import type { Response } from 'express';
import { CorrelationContext } from '@shared/observability/CorrelationContext';
import { MetricsService } from '@shared/observability/MetricsService';
import { ZodValidationPipe } from '@shared/http/ZodValidationPipe';
import { ValidationError } from '@modules/kernel/domain/error/KernelErrors';
import {
  SubmitWagerTransactionInput,
  type SubmitWagerTransactionOutput,
} from '@modules/wagering/application/dto/SubmitWagerTransactionInput';
import { GetWagerTransactionUseCase } from '@modules/wagering/application/usecase/GetWagerTransactionUseCase';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/usecase/SubmitWagerTransactionUseCase';
import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import {
  submitWagerTransactionSchema,
  toKind,
  toMoney,
  type SubmitWagerTransactionBody,
} from './schema/wageringSchema';

interface SubmitResponse {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

interface TransactionResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  createdAt: string;
  processedAt?: string;
}

@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly get: GetWagerTransactionUseCase,
    private readonly metrics: MetricsService,
  ) {}

  /** `Idempotency-Key` é obrigatório e é a fonte da verdade da deduplicação. */
  @Post('wagering/transactions')
  @UsePipes(new ZodValidationPipe(submitWagerTransactionSchema))
  async submitTransaction(
    @Body() body: SubmitWagerTransactionBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitResponse> {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new ValidationError('o header Idempotency-Key é obrigatório');
    }

    const correlationId = CorrelationContext.correlationId ?? CorrelationContext.newCorrelationId();
    CorrelationContext.enrich({ walletId: body.walletId, providerId: body.providerId });

    const startedAt = performance.now();
    // `outcome` só é conhecido no fim, e o caminho de exceção (409/400/503)
    // precisa entrar na mesma métrica — senão o p95 mediria só o sucesso.
    let outcome = 'error';

    try {
      const result = await this.submit.execute(
        SubmitWagerTransactionInput.fromHttp({
          idempotencyKey: idempotencyKey.trim(),
          providerId: body.providerId,
          externalTransactionId: body.externalTransactionId,
          playerId: body.playerId,
          walletId: body.walletId,
          roundId: body.roundId,
          gameId: body.gameId,
          kind: toKind(body.kind),
          money: toMoney(body.money),
          ...(body.referenceExternalTransactionId !== undefined
            ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
            : {}),
          correlationId,
        }),
      );

      outcome = result.outcome;
      res.status(this.statusFor(result));
      return this.toSubmitResponse(result);
    } finally {
      this.metrics.processingDuration.observe(
        { kind: body.kind, source: 'http', outcome },
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  /** 409, 400 e 503 saem pelo `DomainExceptionFilter`, como exceção. */
  private statusFor(result: SubmitWagerTransactionOutput): number {
    switch (result.outcome) {
      case 'processed':
        return HttpStatus.CREATED;
      case 'replay':
        return HttpStatus.OK;
      case 'pending_reference':
        return HttpStatus.ACCEPTED;
      case 'rejected':
        return HttpStatus.UNPROCESSABLE_ENTITY;
      case 'duplicate_message':
        return HttpStatus.OK;
    }
  }

  private toSubmitResponse(result: SubmitWagerTransactionOutput): SubmitResponse {
    if (result.outcome === 'duplicate_message') {
      throw new ValidationError('duplicate_message não é um resultado possível via HTTP');
    }

    return {
      transactionId: result.transaction.id,
      status: result.transaction.status,
      balance: result.balance.toJSON(),
      idempotentReplay: result.idempotentReplay,
      ...(result.outcome === 'rejected' ? { failureCode: result.failureCode } : {}),
    };
  }

  @Get('wagering/transactions/:transactionId')
  async byId(
    @Param('transactionId', new ParseUUIDPipe({ version: '7' })) transactionId: string,
  ): Promise<TransactionResponse> {
    return this.toTransactionResponse(await this.get.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionResponse> {
    return this.toTransactionResponse(
      await this.get.byProviderAndExternalId(providerId, externalTransactionId),
    );
  }

  private toTransactionResponse(transaction: WagerTransaction): TransactionResponse {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      status: transaction.status,
      ...(transaction.failureCode !== undefined ? { failureCode: transaction.failureCode } : {}),
      ...(transaction.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
        : {}),
      createdAt: transaction.createdAt.toISOString(),
      ...(transaction.processedAt !== undefined
        ? { processedAt: transaction.processedAt.toISOString() }
        : {}),
    };
  }
}
