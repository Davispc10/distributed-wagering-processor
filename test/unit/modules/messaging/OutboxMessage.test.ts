import { describe, expect, it } from 'bun:test';
import { Money } from '@modules/kernel/domain/Money';
import { OutboxMessage } from '@modules/messaging/domain/OutboxMessage';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { WagerTransactionProcessed } from '@modules/wagering/domain/event/WagerTransactionEvents';

const AT = new Date('2026-08-11T00:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const makeEvent = (): WagerTransactionProcessed => {
  const tx = WagerTransaction.create({
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'g-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: AT,
  });
  tx.markProcessed(undefined, AT, brl('975.00'));

  return WagerTransactionProcessed.from(tx, brl('975.00').toJSON(), {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    occurredAt: AT,
  });
};

describe('OutboxMessage — enfileiramento', () => {
  it('nasce pendente, sem tentativas', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeUndefined();
  });

  it('herda id, aggregateId, eventType e occurredAt do evento', () => {
    const event = makeEvent();
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe(event.aggregateId);
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.occurredAt).toEqual(AT);
  });

  it('grava o envelope serializado, com money como string decimal', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    const payload = message.payload as unknown as {
      eventType: string;
      version: number;
      data: { money: { amount: unknown } };
    };

    expect(payload.eventType).toBe('WagerTransactionProcessed');
    expect(payload.version).toBe(1);
    expect(typeof payload.data.money.amount).toBe('string');
    expect(payload.data.money.amount).toBe('25.00');
  });

  it('payload sobrevive a JSON.stringify sem perder precisão', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    const roundTripped = JSON.parse(JSON.stringify(message.payload)) as {
      data: { balance: { amount: string } };
    };
    expect(roundTripped.data.balance.amount).toBe('975.00');
  });
});

describe('OutboxMessage — elegibilidade para publicação', () => {
  it('sem nextAttemptAt está sempre pronta', () => {
    expect(OutboxMessage.enqueue(makeEvent()).isDue(AT)).toBe(true);
  });

  it('não está pronta antes do nextAttemptAt', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    message.scheduleRetry(AT);
    expect(message.isDue(AT)).toBe(false);
    expect(message.isDue(new Date(AT.getTime() + 2_000))).toBe(true);
  });

  it('publicada nunca volta a ficar pronta', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    message.markPublished(AT);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(AT.getTime() + 999_999))).toBe(false);
  });
});

describe('OutboxMessage — reidratação do estado persistido', () => {
  const state = {
    id: 'evt-1',
    aggregateId: 't-1',
    eventType: 'WagerTransactionProcessed',
    payload: { eventType: 'WagerTransactionProcessed', version: 1 },
    occurredAt: AT,
    attempts: 3,
    nextAttemptAt: new Date(AT.getTime() + 8_000),
  };

  it('preserva contagem de tentativas e agendamento vindos do banco', () => {
    const message = OutboxMessage.rehydrate(state);

    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(state.nextAttemptAt);
    expect(message.isPending()).toBe(true);
  });

  it('reidratada como publicada não volta a ficar pendente', () => {
    const message = OutboxMessage.rehydrate({ ...state, publishedAt: AT });

    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(AT.getTime() + 999_999))).toBe(false);
  });

  it('retoma o backoff de onde parou, sem reiniciar em 2s', () => {
    const message = OutboxMessage.rehydrate(state);
    message.scheduleRetry(AT);

    expect(message.attempts).toBe(4);
    expect((message.nextAttemptAt!.getTime() - AT.getTime()) / 1000).toBe(16);
  });
});

describe('OutboxMessage — backoff exponencial', () => {
  it('cresce como 2^n e satura em 300s', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    const delays: number[] = [];

    for (let i = 0; i < 10; i++) {
      message.scheduleRetry(AT);
      delays.push((message.nextAttemptAt!.getTime() - AT.getTime()) / 1000);
    }

    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
    expect(message.attempts).toBe(10);
  });

  it('hasExhaustedAttempts respeita o limite', () => {
    const message = OutboxMessage.enqueue(makeEvent());
    expect(message.hasExhaustedAttempts(3)).toBe(false);
    message.scheduleRetry(AT);
    message.scheduleRetry(AT);
    message.scheduleRetry(AT);
    expect(message.hasExhaustedAttempts(3)).toBe(true);
  });
});
