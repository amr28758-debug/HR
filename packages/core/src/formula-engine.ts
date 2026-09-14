/**
 * Safe arithmetic expression evaluator for salary formulas. No eval(). Supports:
 *   numbers, identifiers (variables), + - * / % ^, unary minus, parentheses,
 *   functions: max, min, round, floor, ceil, abs, if(cond, a, b), comparisons (< <= > >= == !=)
 * Example: "hourly_rate * ot_hours * ot_multiplier_normal"
 */
type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

const FUNCS: Record<string, (...a: number[]) => number> = {
  max: (...a) => Math.max(...a),
  min: (...a) => Math.min(...a),
  round: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; },
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  abs: (x) => Math.abs(x),
  if: (c, a, b) => (c ? a : b),
};

export class FormulaError extends Error {}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      const n = Number(src.slice(i, j)); if (Number.isNaN(n)) throw new FormulaError(`bad number at ${i}`);
      out.push({ t: 'num', v: n }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    if (ch === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (ch === ',') { out.push({ t: 'comma' }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%^<>'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new FormulaError(`unexpected character '${ch}' at ${i}`);
  }
  return out;
}

const PREC: Record<string, number> = { '==': 1, '!=': 1, '<': 2, '<=': 2, '>': 2, '>=': 2, '+': 3, '-': 3, '*': 4, '/': 4, '%': 4, '^': 5 };

export type Vars = Record<string, number>;

/** Recursive-descent parser + evaluator. Unknown variables throw. */
export function evaluate(src: string, vars: Vars): number {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function primary(): number {
    const tk = next();
    if (!tk) throw new FormulaError('unexpected end of expression');
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'op' && tk.v === '-') return -primary();
    if (tk.t === 'lp') { const v = expr(0); const r = next(); if (!r || r.t !== 'rp') throw new FormulaError('expected )'); return v; }
    if (tk.t === 'id') {
      const nxt = peek();
      if (nxt && nxt.t === 'lp') {
        next();
        const fn = FUNCS[tk.v]; if (!fn) throw new FormulaError(`unknown function ${tk.v}`);
        const args: number[] = [];
        if (peek()?.t !== 'rp') { for (;;) { args.push(expr(0)); const s = peek(); if (s?.t === 'comma') { next(); continue; } break; } }
        const r = next(); if (!r || r.t !== 'rp') throw new FormulaError('expected ) after arguments');
        return fn(...args);
      }
      if (!(tk.v in vars)) throw new FormulaError(`unknown variable ${tk.v}`);
      const v = vars[tk.v]!;
      if (typeof v !== 'number' || Number.isNaN(v)) throw new FormulaError(`variable ${tk.v} is not a number`);
      return v;
    }
    throw new FormulaError(`unexpected token`);
  }
  function expr(minPrec: number): number {
    let lhs = primary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== 'op' || (PREC[tk.v] ?? -1) < minPrec) return lhs;
      next();
      const prec = PREC[tk.v]!;
      const rhs = expr(tk.v === '^' ? prec : prec + 1);
      switch (tk.v) {
        case '+': lhs += rhs; break; case '-': lhs -= rhs; break; case '*': lhs *= rhs; break;
        case '/': if (rhs === 0) throw new FormulaError('division by zero'); lhs /= rhs; break;
        case '%': lhs %= rhs; break; case '^': lhs = lhs ** rhs; break;
        case '<': lhs = lhs < rhs ? 1 : 0; break; case '<=': lhs = lhs <= rhs ? 1 : 0; break;
        case '>': lhs = lhs > rhs ? 1 : 0; break; case '>=': lhs = lhs >= rhs ? 1 : 0; break;
        case '==': lhs = lhs === rhs ? 1 : 0; break; case '!=': lhs = lhs !== rhs ? 1 : 0; break;
      }
    }
  }
  const v = expr(0);
  if (pos !== toks.length) throw new FormulaError('unexpected trailing tokens');
  return v;
}

/** Validate a formula against a set of allowed variable names without evaluating real data. */
export function validateFormula(src: string, allowedVars: string[]): { ok: true } | { ok: false; error: string } {
  try {
    const vars: Vars = Object.fromEntries(allowedVars.map((v) => [v, 1]));
    evaluate(src, vars);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
