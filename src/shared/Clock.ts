import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** v7 é ordenável por tempo: v4 espalharia as inserções por todo o índice B-tree. */
@Injectable()
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
