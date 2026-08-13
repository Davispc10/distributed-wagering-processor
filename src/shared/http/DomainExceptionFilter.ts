import { ArgumentsHost, Catch, HttpStatus, Injectable, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import {
  BusinessRuleError,
  ConflictError,
  DomainError,
  InvalidTransactionStateError,
  TransientInfrastructureError,
  ValidationError,
} from '@modules/kernel/domain/error/KernelErrors';
import { CorrelationContext } from '@shared/observability/CorrelationContext';
import { LoggerService } from '@shared/observability/LoggerService';

export interface ErrorBody {
  failureCode: string;
  message: string;
  correlationId?: string;
}

interface ErrorResponse {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

/** Curto de propósito: contenção de lock passa em segundos, não em minutos. */
const RETRY_AFTER_SECONDS = 2;

/**
 * Mapeamento único de erro → status. Colapsar tudo num status só obrigaria o
 * provedor a interpretar a mensagem para decidir se pode reenviar. Matriz
 * completa em ARCHITECTURE.md §7.
 *
 * 201/200/202 saem no controller: dependem do `outcome`, não de exceção.
 */
@Catch()
@Injectable()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = CorrelationContext.correlationId;
    const { status, body, headers } = this.describe(exception);

    for (const [name, value] of Object.entries(headers ?? {})) {
      response.setHeader(name, value);
    }

    if (status >= 500) {
      this.logger
        .child('DomainExceptionFilter')
        .error(
          { failureCode: body.failureCode, err: this.messageOf(exception) },
          'falha ao processar requisição',
        );
    }

    response.status(status).json({
      ...body,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }

  private describe(exception: unknown): ErrorResponse {
    // Família inteira, não classe a classe: qualquer conflito de chave é 409.
    if (exception instanceof ConflictError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { failureCode: exception.failureCode, message: exception.message },
      };
    }

    if (exception instanceof ValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { failureCode: exception.failureCode, message: exception.message },
      };
    }

    // `Retry-After` porque 503 sem ele deixa o provedor escolher o intervalo —
    // e provedor com pressa retenta em loop apertado justamente quando o banco
    // está sob contenção.
    if (exception instanceof TransientInfrastructureError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) },
        body: { failureCode: exception.failureCode, message: exception.message },
      };
    }

    // Erro de programação, não caminho de negócio: 500 para não sugerir ao
    // provedor que ele conserta reenviando com outro payload.
    if (exception instanceof InvalidTransactionStateError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: {
          failureCode: 'INTERNAL_ERROR',
          message: 'estado de transação inconsistente',
        },
      };
    }

    if (exception instanceof BusinessRuleError) {
      return {
        status: this.statusForBusinessRule(exception),
        body: {
          failureCode: exception.failureCode,
          message: exception.message,
        },
      };
    }

    if (exception instanceof DomainError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        body: { failureCode: exception.failureCode, message: exception.message },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { failureCode: 'INTERNAL_ERROR', message: 'erro interno' },
    };
  }

  /**
   * "Não encontrado" e "já existe" são conflitos de recurso: um 422 faria o
   * provedor achar que a operação foi avaliada e recusada.
   */
  private statusForBusinessRule(error: BusinessRuleError): number {
    switch (error.failureCode) {
      case FailureCode.WalletNotFound:
        return HttpStatus.NOT_FOUND;
      case FailureCode.WalletAlreadyExists:
        return HttpStatus.CONFLICT;
      case FailureCode.ValidationError:
        return HttpStatus.BAD_REQUEST;
      default:
        return HttpStatus.UNPROCESSABLE_ENTITY;
    }
  }

  private messageOf(exception: unknown): string {
    return exception instanceof Error ? exception.message : String(exception);
  }
}
