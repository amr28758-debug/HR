import { describe, expect, it } from 'vitest';
import { evaluate, validateFormula, FormulaError } from '../src/formula-engine.js';

describe('formula engine', () => {
  it('evaluates arithmetic with precedence and parentheses', () => {
    expect(evaluate('1 + 2 * 3', {})).toBe(7);
    expect(evaluate('(1 + 2) * 3', {})).toBe(9);
    expect(evaluate('2 ^ 3 ^ 2', {})).toBe(512);
    expect(evaluate('-4 + 10 / 4', {})).toBe(-1.5);
    expect(evaluate('10 % 3', {})).toBe(1);
  });
  it('supports variables and functions', () => {
    expect(evaluate('basic_salary / 30 / 8', { basic_salary: 5000 })).toBeCloseTo(20.8333, 3);
    expect(evaluate('hourly_rate * ot_hours * m', { hourly_rate: 20, ot_hours: 10, m: 1.25 })).toBe(250);
    expect(evaluate('max(0, late - grace)', { late: 30, grace: 60 })).toBe(0);
    expect(evaluate('round(10 / 3, 2)', {})).toBe(3.33);
    expect(evaluate('if(days > 15, 1, 0.5)', { days: 20 })).toBe(1);
    expect(evaluate('if(days > 15, 1, 0.5)', { days: 10 })).toBe(0.5);
    expect(evaluate('min(a, b) + abs(-2) + floor(2.9) + ceil(2.1)', { a: 3, b: 2 })).toBe(9);
  });
  it('rejects unknown variables, functions, bad syntax, division by zero', () => {
    expect(() => evaluate('x + 1', {})).toThrow(FormulaError);
    expect(() => evaluate('foo(1)', {})).toThrow(/unknown function/);
    expect(() => evaluate('1 +', {})).toThrow(FormulaError);
    expect(() => evaluate('(1 + 2', {})).toThrow(/expected/);
    expect(() => evaluate('1 / 0', {})).toThrow(/division/);
    expect(() => evaluate('1 $ 2', {})).toThrow(/unexpected character/);
    expect(() => evaluate('process.exit(1)', { process: 1 })).toThrow(FormulaError);
  });
  it('validateFormula reports errors without throwing', () => {
    expect(validateFormula('daily_rate * unpaid_leave_days', ['daily_rate', 'unpaid_leave_days'])).toEqual({ ok: true });
    expect(validateFormula('daily_rate * nope', ['daily_rate']).ok).toBe(false);
  });
});
