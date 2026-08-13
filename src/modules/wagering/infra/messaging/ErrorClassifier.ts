import { Injectable } from '@nestjs/common';
import { isTransientDbError } from '@shared/persistence/UnitOfWork';
import {
  BusinessRuleError,
  ConflictError,
  TransientInfrastructureError,
  ValidationError,
} from '@modules/kernel/domain/error/KernelErrors';

/**
 * business → ack (terminal) · transient → devolve visibilidade · permanent → DLQ.
 *
 * Confundir transient com permanent é o erro caro: mandar para a DLQ o que era
 * indisponibilidade momentânea do banco perde transações financeiras válidas.
 */
export type ErrorClass = 'business' | 'transient' | 'permanent';

@Injectable()
export class ErrorClassifier {
  classify(error: unknown): ErrorClass {
    if (error instanceof TransientInfrastructureError) return 'transient';
    if (isTransientDbError(error)) return 'transient';

    // Terminal: conflito de chave nunca passa por reentrega — nem a mesma key
    // com outro payload, nem um externalTransactionId já usado.
    if (error instanceof ConflictError) return 'business';
    if (error instanceof BusinessRuleError) return 'business';
    if (error instanceof ValidationError) return 'permanent';

    // Desconhecido é transitório de propósito: melhor retentar e cair na DLQ
    // pelo maxReceiveCount do que descartar transação por um bug nosso.
    return 'transient';
  }
}
