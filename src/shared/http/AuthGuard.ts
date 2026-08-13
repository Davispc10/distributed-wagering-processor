import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './Public';

/**
 * No-op deliberado: autenticação não foi implementada por decisão registrada em
 * ARCHITECTURE.md §10, que descreve o desenho OIDC que seria adotado.
 *
 * Autenticar não substituiria nenhuma validação de domínio: o escopo da
 * referência continua sendo checado no use case, inclusive para mensagens da
 * fila.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) return true;

    return true;
  }
}
