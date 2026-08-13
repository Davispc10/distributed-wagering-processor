import { describe, expect, it } from 'bun:test';
import { CorrelationContext } from '@shared/observability/CorrelationContext';
import { createLogger } from '@shared/observability/logger';

/**
 * A seção 12 proíbe dados sensíveis e payloads financeiros completos nos logs.
 *
 * Sem este teste, a redação vaza na primeira linha de debug que alguém
 * esquecer de remover — e num log agregado isso vira exposição permanente.
 */
/**
 * Captura a saída REAL do pino.
 *
 * Inspecionar a configuração de `redact` não provaria nada: o que importa é o
 * que efetivamente chega no stream.
 */
function capture(fn: (log: ReturnType<typeof createLogger>) => void): string {
  const chunks: string[] = [];

  const logger = createLogger({
    level: 'trace',
    instanceId: 'test',
    service: 'test',
    destination: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
  });

  fn(logger);
  return chunks.join('');
}

describe('redação de logs', () => {
  it('não emite valores monetários', () => {
    const output = capture((log) => {
      log.info({ money: { amount: '1234.56', currency: 'BRL' } }, 'transação');
      log.info({ balance: { amount: '9999.99', currency: 'BRL' } }, 'saldo');
      log.info({ amount: '4242.42' }, 'valor solto');
      log.info({ balanceBefore: { amount: '10.00' }, balanceAfter: { amount: '20.00' } }, 'mov');
    });

    expect(output).not.toContain('1234.56');
    expect(output).not.toContain('9999.99');
    expect(output).not.toContain('4242.42');
    expect(output).not.toContain('10.00');
    expect(output).not.toContain('20.00');
    expect(output).toContain('[REDACTED]');
  });

  it('não emite payloads completos nem cabeçalhos sensíveis', () => {
    const output = capture((log) => {
      log.info({ payload: { segredo: 'nao-deve-aparecer' } }, 'payload');
      log.info({ body: { cartao: '4111111111111111' } }, 'body');
      log.info({ headers: { authorization: 'Bearer token-secreto' } }, 'headers');
    });

    expect(output).not.toContain('nao-deve-aparecer');
    expect(output).not.toContain('4111111111111111');
    expect(output).not.toContain('token-secreto');
  });

  it('PRESERVA os campos de diagnóstico exigidos pela seção 12', () => {
    const output = capture((log) => {
      log.info(
        {
          transactionId: 'tx-123',
          walletId: 'w-456',
          providerId: 'provider-a',
          messageId: 'msg-789',
          kind: 'BET',
          status: 'PROCESSED',
          failureCode: 'INSUFFICIENT_FUNDS',
        },
        'processada',
      );
    });

    expect(output).toContain('tx-123');
    expect(output).toContain('w-456');
    expect(output).toContain('provider-a');
    expect(output).toContain('msg-789');
    expect(output).toContain('BET');
    expect(output).toContain('INSUFFICIENT_FUNDS');
  });

  it('injeta o correlationId do contexto sem o call site precisar passá-lo', () => {
    const output = CorrelationContext.run({ correlationId: 'corr-abc-123' }, () =>
      capture((log) => {
        log.info('sem campos explícitos');
      }),
    );

    expect(output).toContain('corr-abc-123');
  });

  it('propaga os campos enriquecidos no meio do processamento', () => {
    const output = CorrelationContext.run({ correlationId: 'corr-xyz' }, () => {
      CorrelationContext.enrich({ transactionId: 'tx-enriquecida', walletId: 'w-enriquecida' });
      return capture((log) => {
        log.info('depois do enrich');
      });
    });

    expect(output).toContain('tx-enriquecida');
    expect(output).toContain('w-enriquecida');
  });

  it('a saída é JSON válido, uma linha por evento', () => {
    const output = capture((log) => {
      log.info({ transactionId: 'tx-1' }, 'primeira');
      log.warn({ transactionId: 'tx-2' }, 'segunda');
    });

    const lines = output.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { level: string; msg: string };
      expect(typeof parsed.level).toBe('string');
      expect(typeof parsed.msg).toBe('string');
    }
  });
});
