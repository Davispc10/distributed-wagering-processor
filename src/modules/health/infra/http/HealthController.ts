import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '@shared/http/Public';
import { MetricsService } from '@shared/observability/MetricsService';
import {
  CheckReadinessUseCase,
  type ReadinessOutput,
} from '@modules/health/application/usecase/CheckReadinessUseCase';

@Controller()
export class HealthController {
  constructor(
    private readonly checkReadiness: CheckReadinessUseCase,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Não toca em dependência externa de propósito: com o Postgres fora queremos
   * a instância removida do balanceador, não reiniciada em loop.
   */
  @Public()
  @Get('health/live')
  live(): { status: 'alive'; uptimeSeconds: number } {
    return { status: 'alive', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Public()
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessOutput> {
    const result = await this.checkReadiness.execute();
    res.status(result.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  @Public()
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async prometheusMetrics(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.metrics();
  }
}
