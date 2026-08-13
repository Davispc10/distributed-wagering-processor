import { z } from 'zod';
import { Money } from '@modules/kernel/domain/Money';
import type { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { SUBMITTABLE_KINDS } from '@modules/wagering/domain/enum/WagerTransactionKind';

/**
 * Rejeita antes do domínio para o provedor receber 400 com o campo inválido. A
 * validação de domínio continua existindo: é ela que protege o consumidor SQS.
 */
export const moneySchema = z.object({
  amount: z
    .string()
    .regex(
      /^(0|[1-9]\d*)(\.\d{1,2})?$/,
      'amount deve ser decimal com até 2 casas, sem notação científica nem separador de milhar',
    ),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency deve ser ISO-4217 com 3 letras maiúsculas'),
});

export const submitWagerTransactionSchema = z.object({
  providerId: z.string().min(1).max(128),
  externalTransactionId: z.string().min(1).max(128),
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: z.string().min(1).max(128),
  gameId: z.string().min(1).max(128),
  kind: z.enum(SUBMITTABLE_KINDS as unknown as [string, ...string[]]),
  money: moneySchema,
  referenceExternalTransactionId: z.string().min(1).max(128).optional(),
});

export type SubmitWagerTransactionBody = z.infer<typeof submitWagerTransactionSchema>;

export const openWalletSchema = z.object({
  playerId: z.string().uuid(),
  initialBalance: moneySchema,
});

export type OpenWalletBody = z.infer<typeof openWalletSchema>;

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type LedgerQueryParams = z.infer<typeof ledgerQuerySchema>;

export function toMoney(props: { amount: string; currency: string }): Money {
  return Money.from(props);
}

export function toKind(kind: string): WagerTransactionKind {
  return kind as WagerTransactionKind;
}
