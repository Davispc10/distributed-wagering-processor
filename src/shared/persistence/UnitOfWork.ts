import { EntityManager, RequestContext } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { MetricsService } from '@shared/observability/MetricsService';
import { TransientInfrastructureError } from '@modules/kernel/domain/error/KernelErrors';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** serialization_failure, deadlock, lock_timeout, statement_timeout. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014']);

/** Subconjunto que é disputa pelo mesmo lock de wallet, não indisponibilidade. */
const LOCK_CONFLICT_SQLSTATES: Readonly<Record<string, string>> = {
  '40001': 'serialization_failure',
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
};

export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code !== 'string') return false;
  return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || code === '53300';
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const err = error as { code?: string; constraint?: string } | null;
  if (err?.code !== '23505') return false;
  return constraint === undefined || err.constraint === constraint;
}

/**
 * `RequestContext.create` é obrigatório: sem ele os repositórios resolvem para
 * o EntityManager global em vez do fork transacional, cada um abre a própria
 * conexão e a atomicidade entre wallet, ledger, inbox e outbox deixa de existir.
 */
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional(async (tx) => {
        return RequestContext.create(tx, async () => work());
      });
    } catch (error: unknown) {
      if (isTransientDbError(error)) {
        const code = (error as { code?: string }).code ?? 'desconhecido';

        // Aqui o SQLSTATE ainda existe. Um andar acima só resta a mensagem, e
        // contar conflito de lock por `includes('lock')` erraria nos dois
        // sentidos — este é o único ponto em que a classificação é exata.
        const conflict = LOCK_CONFLICT_SQLSTATES[code];
        if (conflict !== undefined) {
          this.metrics.lockConflictsTotal.inc({ operation: conflict });
        }

        throw new TransientInfrastructureError(
          `contenção ou indisponibilidade no banco: ${code}`,
          error,
        );
      }
      throw error;
    }
  }
}
