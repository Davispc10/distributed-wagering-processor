export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito da API nem da fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** `OPENING` fica de fora: é interno. */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const KINDS_REQUIRING_REFERENCE: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** REFUND só reverte BET. */
export const REFUNDABLE_KINDS: readonly WagerTransactionKind[] = [WagerTransactionKind.Bet];

/** ROLLBACK reverte BET, WIN ou REFUND. */
export const ROLLBACKABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];
