import { InvalidTransactionStateError } from '@modules/kernel/domain/error/KernelErrors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Dedup persistente do consumidor. A corrida entre duas entregas da mesma
 * mensagem é decidida no banco (`PK (consumer_name, message_id)`), não aqui — a
 * entidade guarda o ciclo de vida de UMA mensagem já reivindicada.
 *
 * A identidade é `(consumerName, messageId)` e não só `messageId`: consumidores
 * diferentes precisam processar a mesma mensagem cada um a seu tempo.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  /** Nasce não processada: o `processedAt` só existe depois do commit do efeito. */
  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /**
   * Terminal. Marcar duas vezes significaria que o efeito foi aplicado duas
   * vezes — é erro de programação, não a duplicata esperada do at-least-once
   * (essa é barrada antes, pelo `claim`).
   */
  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvalidTransactionStateError(
        `mensagem ${this.messageId} do consumidor ${this.consumerName} já estava processada ` +
          `em ${this._processedAt.toISOString()}`,
      );
    }
    this._processedAt = at;
  }

  /** Mesma messageId com payload diferente indica reuso de id pelo produtor. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
