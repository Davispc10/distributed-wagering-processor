import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';

@Injectable()
export class SqsClientProvider implements OnModuleDestroy {
  readonly client: SQSClient;
  private readonly urlCache = new Map<string, string>();

  constructor(private readonly config: AppConfig) {
    const aws = config.aws;
    this.client = new SQSClient({
      endpoint: aws.endpoint,
      region: aws.region,
      credentials: {
        accessKeyId: aws.accessKeyId,
        secretAccessKey: aws.secretAccessKey,
      },
    });
  }

  async queueUrl(queueName: string): Promise<string> {
    const cached = this.urlCache.get(queueName);
    if (cached !== undefined) return cached;

    const res = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!res.QueueUrl) {
      throw new Error(
        `Fila "${queueName}" não encontrada em ${this.config.aws.endpoint}. Rode "bun run queues:bootstrap".`,
      );
    }

    this.urlCache.set(queueName, res.QueueUrl);
    return res.QueueUrl;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
