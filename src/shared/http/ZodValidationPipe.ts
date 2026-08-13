import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { ValidationError } from '@modules/kernel/domain/error/KernelErrors';

/**
 * Converte falha de schema em `ValidationError` de domínio: sem isso, o provedor
 * teria dois formatos de erro diferentes na mesma API.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
        .join('; ');
      throw new ValidationError(details);
    }

    return result.data;
  }
}
