import { ValidationError } from '@modules/kernel/domain/error/KernelErrors';

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

/**
 * `id` entra como desempate porque dois lançamentos podem dividir o mesmo
 * `created_at` no mesmo milissegundo — sem ele, a página perderia ou repetiria
 * registros exatamente sob carga concorrente.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('cursor inválido');
  }

  const separator = decoded.lastIndexOf('|');
  if (separator === -1) throw new ValidationError('cursor inválido');

  const isoDate = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const createdAt = new Date(isoDate);

  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new ValidationError('cursor inválido');
  }

  return { createdAt, id };
}
