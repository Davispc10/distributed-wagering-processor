import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MoneyProps } from '@modules/kernel/domain/Money';

/**
 * Só campos de negócio. Header, metadados de transporte e `messageId` ficam de
 * fora: a mesma operação por HTTP e por SQS precisa gerar o mesmo hash, senão
 * um replay legítimo viraria conflito.
 */
export interface HashableWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * JSON canônico (chaves ordenadas recursivamente) + SHA-256 hex.
 *
 * A ordenação recursiva é o ponto crítico: sem ela, o mesmo payload montado em
 * ordem diferente pelo provedor geraria hash diferente, transformando replay em
 * conflito 409. Algoritmo completo em ARCHITECTURE.md §4.
 */
@Injectable()
export class PayloadHasher {
  hash(payload: HashableWagerPayload): string {
    return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
  }
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }

  return JSON.stringify(value);
}
