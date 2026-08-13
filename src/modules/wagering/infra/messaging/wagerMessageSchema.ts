import { z } from 'zod';
import { moneySchema } from '@modules/wagering/infra/http/schema/wageringSchema';
import { SUBMITTABLE_KINDS } from '@modules/wagering/domain/enum/WagerTransactionKind';

/**
 * `messageId` vem do CORPO, não do `MessageId` do SQS: a chave do inbox precisa
 * sobreviver a uma republicação, e o id do broker muda a cada envio.
 */
export const wagerTransactionMessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime(),
  data: z.object({
    providerId: z.string().min(1).max(128),
    externalTransactionId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(256),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: z.string().min(1).max(128),
    gameId: z.string().min(1).max(128),
    kind: z.enum(SUBMITTABLE_KINDS as unknown as [string, ...string[]]),
    money: moneySchema,
    referenceExternalTransactionId: z.string().min(1).max(128).optional(),
    correlationId: z.string().min(1).max(128).optional(),
  }),
});

export type WagerTransactionMessage = z.infer<typeof wagerTransactionMessageSchema>;
