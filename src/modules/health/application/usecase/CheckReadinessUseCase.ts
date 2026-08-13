import { Inject, Injectable } from '@nestjs/common';
import {
  HEALTH_PROBES,
  type HealthProbe,
  type HealthProbeResult,
} from '@modules/health/application/port/HealthProbe';

export interface ReadinessOutput {
  status: 'ready' | 'not_ready';
  checks: HealthProbeResult[];
}

/**
 * Probes em paralelo: encadeados, o timeout do readiness seria a soma dos
 * timeouts, atrasando a saída da instância doente do balanceador.
 */
@Injectable()
export class CheckReadinessUseCase {
  constructor(@Inject(HEALTH_PROBES) private readonly probes: HealthProbe[]) {}

  async execute(): Promise<ReadinessOutput> {
    const checks = await Promise.all(this.probes.map((probe) => probe.check()));
    const healthy = checks.every((check) => check.healthy);

    return { status: healthy ? 'ready' : 'not_ready', checks };
  }
}
