import { describe, expect, it } from 'bun:test';
import { Money } from '@modules/kernel/domain/Money';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '@modules/kernel/domain/error/KernelErrors';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money — construção e validação', () => {
  it('aceita decimal com 2 casas', () => {
    expect(brl('25.00').toString()).toBe('25.00');
    expect(brl('0.01').toString()).toBe('0.01');
    expect(brl('1000000.99').toString()).toBe('1000000.99');
  });

  it('normaliza para escala fixa de 2 casas', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0').toString()).toBe('0.00');
  });

  it.each([
    ['string vazia', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e5'],
    ['notação científica maiúscula', '1E5'],
    ['notação científica negativa', '1e-5'],
    ['três casas decimais', '25.001'],
    ['quatro casas decimais', '10.1234'],
    ['separador de milhar', '1,000.00'],
    ['espaço', ' 25.00'],
    ['espaço no fim', '25.00 '],
    ['só ponto', '.'],
    ['ponto sem decimais', '25.'],
    ['texto', 'abc'],
    ['zero à esquerda', '025.00'],
    ['sinal de mais', '+25.00'],
    ['hexadecimal', '0x10'],
  ])('rejeita %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejeita valor negativo em contrato de entrada', () => {
    expect(() => brl('-25.00')).toThrow(InvalidMoneyError);
  });

  it('parse aceita negativo — usado por lançamento invertido e reidratação', () => {
    const negative = Money.parse({ amount: '-25.00', currency: 'BRL' });
    expect(negative.isNegative()).toBe(true);
    expect(negative.toString()).toBe('-25.00');
  });

  it.each([
    ['minúscula', 'brl'],
    ['duas letras', 'BR'],
    ['quatro letras', 'BRLX'],
    ['vazia', ''],
    ['com dígito', 'BR1'],
  ])('rejeita currency %s', (_label, currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('zero produz 0.00 na moeda informada', () => {
    expect(Money.zero('USD').toString()).toBe('0.00');
    expect(Money.zero('USD').currency).toBe('USD');
    expect(Money.zero('BRL').isZero()).toBe(true);
  });
});

describe('Money — aritmética exata', () => {
  it('soma sem erro de ponto flutuante', () => {
    // 0.1 + 0.2 === 0.30000000000000004 em float. Aqui precisa ser 0.30.
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('não acumula erro em somas repetidas', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.toString()).toBe('10.00');
  });

  it('subtrai e pode resultar negativo', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.toString()).toBe('-15.00');
    expect(result.isNegative()).toBe(true);
  });

  it('nega e volta ao original', () => {
    expect(brl('25.00').negate().toString()).toBe('-25.00');
    expect(brl('25.00').negate().negate().toString()).toBe('25.00');
  });

  it('abs remove o sinal', () => {
    expect(brl('25.00').negate().abs().toString()).toBe('25.00');
  });

  it('é imutável: operação não altera a instância original', () => {
    const original = brl('100.00');
    original.add(brl('50.00'));
    original.subtract(brl('30.00'));
    original.negate();
    expect(original.toString()).toBe('100.00');
  });

  it('preserva valores grandes sem perda de precisão', () => {
    const big = brl('99999999999999.99');
    expect(big.add(brl('0.01')).toString()).toBe('100000000000000.00');
  });
});

describe('Money — comparações', () => {
  it('compara corretamente', () => {
    expect(brl('10.00').isLessThan(brl('20.00'))).toBe(true);
    expect(brl('20.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('20.00').isGreaterThan(brl('10.00'))).toBe(true);
  });

  it('equals exige mesma moeda e mesmo valor', () => {
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    expect(brl('10.00').equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
  });

  it('10.00 e 10 são o mesmo valor', () => {
    expect(brl('10').equals(brl('10.00'))).toBe(true);
  });

  it('isPositive / isNegative / isZero', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('1.00').negate().isNegative()).toBe(true);
  });
});

describe('Money — conflito de moeda', () => {
  const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ['isGreaterThan', (a: Money, b: Money) => a.isGreaterThan(b)],
  ])('%s entre moedas diferentes lança erro de domínio', (_label, op) => {
    expect(() => op(brl('10.00'), usd('10.00'))).toThrow(CurrencyMismatchError);
  });

  it('equals entre moedas diferentes retorna false em vez de lançar', () => {
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
  });
});

describe('Money — serialização', () => {
  it('toJSON devolve string decimal e moeda', () => {
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  it('sobrevive a um round-trip JSON', () => {
    const original = brl('1234.56');
    const restored = Money.from(JSON.parse(JSON.stringify(original.toJSON())) as never);
    expect(restored.equals(original)).toBe(true);
  });

  it('nunca serializa como number', () => {
    const serialized = JSON.stringify(brl('25.00').toJSON());
    expect(serialized).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(typeof (JSON.parse(serialized) as { amount: unknown }).amount).toBe('string');
  });
});
