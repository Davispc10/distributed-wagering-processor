import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from '@modules/kernel/domain/error/KernelErrors';
import { InboxMessage } from '@modules/messaging/domain/InboxMessage';

const RECEIVED_AT = new Date('2026-08-11T00:00:00.000Z');
const PROCESSED_AT = new Date('2026-08-11T00:00:01.000Z');

const make = (overrides: Partial<Parameters<typeof InboxMessage.receive>[0]> = {}): InboxMessage =>
  InboxMessage.receive({
    messageId: 'msg-123',
    consumerName: 'wager-transaction-consumer',
    payloadHash: 'hash-1',
    receivedAt: RECEIVED_AT,
    ...overrides,
  });

describe('InboxMessage — recebimento', () => {
  it('nasce não processada', () => {
    const message = make();
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('preserva a identidade composta (consumidor, messageId)', () => {
    const message = make();
    expect(message.messageId).toBe('msg-123');
    expect(message.consumerName).toBe('wager-transaction-consumer');
  });
});

describe('InboxMessage — marcação de processada', () => {
  it('markProcessed grava o instante e torna isProcessed verdadeiro', () => {
    const message = make();
    message.markProcessed(PROCESSED_AT);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSED_AT);
  });

  /** Marcar duas vezes significaria efeito aplicado duas vezes. */
  it('recusa marcar duas vezes — é erro de programação, não duplicata de fila', () => {
    const message = make();
    message.markProcessed(PROCESSED_AT);

    expect(() => message.markProcessed(new Date('2026-08-11T00:00:02.000Z'))).toThrow(
      InvalidTransactionStateError,
    );
    // E o instante original permanece: a auditoria não é reescrita.
    expect(message.processedAt).toEqual(PROCESSED_AT);
  });

  it('reidratada como processada não aceita nova marcação', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-123',
      consumerName: 'wager-transaction-consumer',
      payloadHash: 'hash-1',
      receivedAt: RECEIVED_AT,
      processedAt: PROCESSED_AT,
    });

    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(new Date())).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage — reidratação', () => {
  it('reconstrói o estado pendente vindo do banco', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-9',
      consumerName: 'outro-consumidor',
      payloadHash: 'hash-9',
      receivedAt: RECEIVED_AT,
    });

    expect(message.isProcessed()).toBe(false);
    expect(message.payloadHash).toBe('hash-9');
  });
});

describe('InboxMessage — payload', () => {
  it('mesmo hash é a duplicata esperada do at-least-once', () => {
    expect(make().matchesPayload('hash-1')).toBe(true);
  });

  it('hash diferente indica reuso de messageId pelo produtor', () => {
    expect(make().matchesPayload('hash-outro')).toBe(false);
  });
});
