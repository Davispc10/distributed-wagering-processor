import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { HealthProbe, HealthProbeResult } from '@modules/health/application/port/HealthProbe';

@Injectable()
export class PostgresHealthProbe implements HealthProbe {
  readonly name = 'postgres';

  constructor(private readonly em: EntityManager) {}

  async check(): Promise<HealthProbeResult> {
    const startedAt = performance.now();
    try {
      await this.em.getConnection().execute('SELECT 1');
      return {
        name: this.name,
        healthy: true,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error: unknown) {
      return {
        name: this.name,
        healthy: false,
        latencyMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
