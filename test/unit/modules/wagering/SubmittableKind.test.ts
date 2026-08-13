import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import type { SubmitWagerTransactionInput } from '@modules/wagering/application/dto/SubmitWagerTransactionInput';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/usecase/SubmitWagerTransactionUseCase';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';

/**
 * `OPENING` já é barrado pelos schemas zod do HTTP e da fila, então esta guarda
 * é defesa em profundidade — só dispara se alguém afrouxar um schema. É também
 * o motivo de não existir teste de integração para ela: pela superfície pública
 * o caso é inalcançável.
 *
 * Como a checagem é a PRIMEIRA instrução de `execute()` e só lê `input.kind`,
 * dá para exercitá-la sem montar o grafo de injeção.
 */
describe('SubmitWagerTransactionUseCase — kinds internos', () => {
  const useCase = Reflect.construct(
    SubmitWagerTransactionUseCase,
    [],
  ) as SubmitWagerTransactionUseCase;

  it('recusa OPENING com INVALID_TRANSACTION_KIND', async () => {
    const input = { kind: WagerTransactionKind.Opening } as SubmitWagerTransactionInput;

    let caught: unknown;
    try {
      await useCase.execute(input);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BusinessRuleError);
    expect((caught as BusinessRuleError).failureCode).toBe(FailureCode.InvalidTransactionKind);
  });
});
