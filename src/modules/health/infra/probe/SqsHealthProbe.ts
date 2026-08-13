import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { SqsClientProvider } from '@shared/messaging/SqsClientProvider';
import type { HealthProbe, HealthProbeResult } from '@modules/health/application/port/HealthProbe';

/**
 * Checa a fila, não só a conectividade: um broker de pé com a fila inexistente
 * responderia "saudável" e a instância falharia na primeira mensagem.
 */
@Injectable()
export class SqsHealthProbe implements HealthProbe {
  readonly name = 'sqs';

  constructor(
    private readonly sqs: SqsClientProvider,
    private readonly config: AppConfig,
  ) {}

  async check(): Promise<HealthProbeResult> {
    const startedAt = performance.now();
    try {
      const queueUrl = await this.sqs.queueUrl(this.config.queues.wagerTransactions);
      await this.sqs.client.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
      );
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
