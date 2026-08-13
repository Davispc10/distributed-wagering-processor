export interface HealthProbeResult {
  name: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthProbe {
  readonly name: string;
  check(): Promise<HealthProbeResult>;
}

export const HEALTH_PROBES = Symbol('HEALTH_PROBES');
