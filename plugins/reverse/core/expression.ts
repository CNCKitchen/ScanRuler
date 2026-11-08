// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic a number field takes: `25.4/12`, `threadlength + 10`,
// `sin(30) * r`. A small language of its own — numbers with an optional
// unit, the parameters by name, the four operations and a power, a few
// functions — parsed and evaluated here, and kind-checked as it goes: a
// length and an angle cannot be added, a length times a length is an area
// and no field wants one. A bare number has no kind of its own until it
// meets something that has one, or lands in a field that has — `10` is ten
// millimetres in a length field and ten degrees in an angle field, and
// `width / 2` is a length because `2` stays a plain scalar beside a length.
//
// Every reading of an expression goes through the one tokenizer below —
// what evaluates it, what finds the names it uses, what rewrites a name —
// so a parameter renamed is renamed everywhere the same way.

import { type DisplayUnits, lengthDecimals, toDisplay, unitWord } from '../../../src/core/units'

/** What a parameter is, and what a number field wants: a length in
 *  millimetres, an angle in degrees, a whole number, or a plain number. */
export type ParameterKind = 'length' | 'angle' | 'integer' | 'number'

/** The kind of a value as exponents of millimetres and degrees — a length
 *  is mm¹, an area mm², a ratio mm⁰ — or `free`: a bare number that takes
 *  the kind of whatever it meets. */
export type Dim = { mm: number; deg: number } | 'free'

export const UNITLESS: Dim = { mm: 0, deg: 0 }
export const LENGTH: Dim = { mm: 1, deg: 0 }
export const ANGLE: Dim = { mm: 0, deg: 1 }

/** The kind a field of this kind wants. */
export function dimOfKind(kind: ParameterKind): Dim {
  return kind === 'length' ? LENGTH : kind === 'angle' ? ANGLE : UNITLESS
}

/** A value as the evaluator hands it on: its number and its kind. */
export interface Value {
  value: number
  dim: Dim
}

/** What a name in an expression stands for: its value, or why it has none
 *  (a parameter that cannot be read), or undefined for no such name. */
export type Scope = (name: string) => Value | { error: string } | undefined

export type Evaluated = { ok: true; value: number; dim: Dim } | { ok: false; error: string; at: [number, number] }

/** The units a number may carry, and what one of each is in the
 *  workspace's own millimetres and degrees. */
const UNITS: Record<string, Value> = {
  mm: { value: 1, dim: LENGTH },
  cm: { value: 10, dim: LENGTH },
  m: { value: 1000, dim: LENGTH },
  in: { value: 25.4, dim: LENGTH },
  deg: { value: 1, dim: ANGLE },
  rad: { value: 180 / Math.PI, dim: ANGLE },
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'pow'])

/** The names an expression already means something by, which no parameter
 *  may take. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([...Object.keys(UNITS), ...Object.keys(CONSTANTS), ...FUNCTIONS])

/** Whether a name may be a parameter's: a letter or an underscore, then
 *  letters, digits and underscores — and not a word the language keeps. */
export function validName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_NAMES.has(name)
}

// ---- tokens --------------------------------------------------------------------

type Token =
  | { kind: 'number'; value: number; at: [number, number] }
  | { kind: 'name'; text: string; at: [number, number] }
  | { kind: 'op'; text: '+' | '-' | '*' | '/' | '^' | '(' | ')' | ','; at: [number, number] }
  | { kind: 'end'; at: [number, number] }

class ExpressionError extends Error {
  constructor(
    message: string,
    public at: [number, number],
  ) {
    super(message)
  }
}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const rest = src.slice(i)
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(rest)
    if (num) {
      out.push({ kind: 'number', value: Number(num[0]), at: [i, i + num[0].length] })
      i += num[0].length
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (name) {
      out.push({ kind: 'name', text: name[0], at: [i, i + name[0].length] })
      i += name[0].length
      continue
    }
    if (c === '°') {
      out.push({ kind: 'name', text: 'deg', at: [i, i + 1] })
      i++
      continue
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^' || c === '(' || c === ')' || c === ',') {
      out.push({ kind: 'op', text: c, at: [i, i + 1] })
      i++
      continue
    }
    if (c === '×' || c === '·') {
      out.push({ kind: 'op', text: '*', at: [i, i + 1] })
      i++
      continue
    }
    if (c === '÷' || c === ':') {
      out.push({ kind: 'op', text: '/', at: [i, i + 1] })
      i++
      continue
    }
    if (c === '−') {
      out.push({ kind: 'op', text: '-', at: [i, i + 1] })
      i++
      continue
    }
    throw new ExpressionError(c === ',' ? 'a comma separates a function’s arguments; the decimal point is a dot' : `“${c}” is not part of an expression`, [i, i + 1])
  }
  out.push({ kind: 'end', at: [src.length, src.length] })
  return out
}

// ---- the tree ------------------------------------------------------------------

type Node =
  | { kind: 'number'; value: number; unit: string | null; at: [number, number] }
  | { kind: 'name'; name: string; at: [number, number] }
  | { kind: 'neg'; arg: Node; at: [number, number] }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node; at: [number, number] }
  | { kind: 'call'; name: string; args: Node[]; at: [number, number] }

const BINARY_POWER: Record<'+' | '-' | '*' | '/' | '^', number> = { '+': 10, '-': 10, '*': 20, '/': 20, '^': 30 }
/** Unary minus binds under a power, so −2² is −4, and over a product. */
const NEGATE_POWER = 25

/** How deep an expression may nest, in parentheses, functions and signs:
 *  far past anything typed, and short of the stack the parser and the
 *  evaluation recurse on, which an expression from a file could exhaust. */
const MAX_DEPTH = 200

/** The longest expression read, in characters: a chain of operators is
 *  evaluated as deep as it is long. */
const MAX_LENGTH = 4000

class Parser {
  private i = 0
  private depth = 0
  constructor(private tokens: Token[]) {}

  parse(): Node {
    if (this.tokens[0].kind === 'end') throw new ExpressionError('nothing to read', [0, 0])
    const node = this.expression(0)
    const t = this.peek()
    if (t.kind !== 'end') throw new ExpressionError(t.kind === 'op' && t.text === ')' ? 'a “)” with no “(” before it' : `“${this.text(t)}” where an operator was expected`, t.at)
    return node
  }

  private peek(): Token {
    return this.tokens[this.i]
  }

  private next(): Token {
    return this.tokens[this.i++]
  }

  private text(t: Token): string {
    return t.kind === 'number' ? String(t.value) : t.kind === 'name' ? t.text : t.kind === 'op' ? t.text : 'the end'
  }

  private expression(minPower: number): Node {
    if (++this.depth > MAX_DEPTH) throw new ExpressionError('nests too deeply', this.peek().at)
    try {
      return this.operators(minPower)
    } finally {
      this.depth--
    }
  }

  private operators(minPower: number): Node {
    let left = this.prefix()
    for (;;) {
      const t = this.peek()
      if (t.kind !== 'op' || t.text === '(' || t.text === ')' || t.text === ',') break
      const power = BINARY_POWER[t.text]
      if (power < minPower) break
      this.next()
      // A power binds to the right (2^3^2 is 2^9); the rest to the left.
      const right = this.expression(t.text === '^' ? power : power + 1)
      left = { kind: 'binary', op: t.text, a: left, b: right, at: [left.at[0], right.at[1]] }
    }
    return left
  }

  private prefix(): Node {
    const t = this.next()
    if (t.kind === 'number') {
      const unit = this.peek()
      if (unit.kind === 'name' && UNITS[unit.text]) {
        this.next()
        return { kind: 'number', value: t.value, unit: unit.text, at: [t.at[0], unit.at[1]] }
      }
      return { kind: 'number', value: t.value, unit: null, at: t.at }
    }
    if (t.kind === 'name') {
      const open = this.peek()
      if (open.kind === 'op' && open.text === '(') {
        if (!FUNCTIONS.has(t.text)) throw new ExpressionError(`there is no function “${t.text}”`, t.at)
        this.next()
        const args: Node[] = []
        if (!(this.peek().kind === 'op' && (this.peek() as { text: string }).text === ')')) {
          for (;;) {
            args.push(this.expression(0))
            const sep = this.peek()
            if (sep.kind === 'op' && sep.text === ',') {
              this.next()
              continue
            }
            break
          }
        }
        const close = this.next()
        if (!(close.kind === 'op' && close.text === ')')) throw new ExpressionError(`“${t.text}(” is not closed`, [t.at[0], close.at[1]])
        return { kind: 'call', name: t.text, args, at: [t.at[0], close.at[1]] }
      }
      // A constant takes a unit as a number does: `pi rad` is half a turn.
      if (t.text in CONSTANTS && open.kind === 'name' && UNITS[open.text]) {
        this.next()
        return { kind: 'number', value: CONSTANTS[t.text], unit: open.text, at: [t.at[0], open.at[1]] }
      }
      return { kind: 'name', name: t.text, at: t.at }
    }
    if (t.kind === 'op' && t.text === '(') {
      const inner = this.expression(0)
      const close = this.next()
      if (!(close.kind === 'op' && close.text === ')')) throw new ExpressionError('a “(” is not closed', [t.at[0], close.at[1]])
      return inner
    }
    if (t.kind === 'op' && t.text === '-') {
      const arg = this.expression(NEGATE_POWER)
      return { kind: 'neg', arg, at: [t.at[0], arg.at[1]] }
    }
    if (t.kind === 'op' && t.text === '+') return this.expression(NEGATE_POWER)
    if (t.kind === 'end') throw new ExpressionError('the expression ends where a number was expected', t.at)
    throw new ExpressionError(`“${this.text(t)}” where a number was expected`, t.at)
  }
}

// ---- kinds ----------------------------------------------------------------------

function dimEqual(a: Dim, b: Dim): boolean {
  if (a === 'free' || b === 'free') return a === b
  return a.mm === b.mm && a.deg === b.deg
}

/** A kind in words: "a length", "an angle", "a number", "an area (mm²)". */
function describeDim(d: Dim): string {
  if (d === 'free') return 'a number'
  if (d.mm === 0 && d.deg === 0) return 'a number'
  if (d.mm === 1 && d.deg === 0) return 'a length'
  if (d.mm === 0 && d.deg === 1) return 'an angle'
  // units-ok: the expression grammar's base unit.
  if (d.mm === 2 && d.deg === 0) return 'an area (mm²)'
  // units-ok: the expression grammar's base unit.
  if (d.mm === 3 && d.deg === 0) return 'a volume (mm³)'
  const sup = (n: number) => (n === 1 ? '' : String(n).replace(/-/g, '⁻').replace(/\d/g, (c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)]))
  const parts: string[] = []
  // units-ok: expression grammar — a quantity's kind in the grammar's own base unit
  if (d.mm !== 0) parts.push(`mm${sup(d.mm)}`)
  if (d.deg !== 0) parts.push(`°${sup(d.deg)}`)
  return `a ${parts.join('·')} quantity`
}

/** What a field of this kind wants, in words. */
function describeKind(kind: ParameterKind): string {
  return kind === 'length' ? 'a length' : kind === 'angle' ? 'an angle' : kind === 'integer' ? 'a whole number' : 'a number'
}

function combine(a: Dim, b: Dim, f: (x: number, y: number) => number): Dim {
  if (a === 'free') return b === 'free' ? 'free' : { mm: f(0, b.mm), deg: f(0, b.deg) }
  if (b === 'free') return { mm: f(a.mm, 0), deg: f(a.deg, 0) }
  return { mm: f(a.mm, b.mm), deg: f(a.deg, b.deg) }
}

const nearInt = (x: number) => Math.abs(x - Math.round(x)) < 1e-9

function power(base: Dim, exp: number, at: [number, number]): Dim {
  if (base === 'free') return 'free'
  const mm = base.mm * exp
  const deg = base.deg * exp
  if (!nearInt(mm) || !nearInt(deg)) throw new ExpressionError(`${describeDim(base)} cannot be raised to the power ${exp}`, at)
  return { mm: Math.round(mm), deg: Math.round(deg) }
}

function same(a: Value, b: Value, what: string, at: [number, number]): Dim {
  if (a.dim === 'free') return b.dim
  if (b.dim === 'free') return a.dim
  if (dimEqual(a.dim, b.dim)) return a.dim
  throw new ExpressionError(`${describeDim(a.dim)} and ${describeDim(b.dim)} cannot ${what}`, at)
}

// ---- evaluation -------------------------------------------------------------------

function evaluateNode(n: Node, scope: Scope): Value {
  switch (n.kind) {
    case 'number': {
      if (n.unit === null) return { value: n.value, dim: 'free' }
      const u = UNITS[n.unit]
      return { value: n.value * u.value, dim: u.dim }
    }
    case 'name': {
      if (n.name in CONSTANTS) return { value: CONSTANTS[n.name], dim: 'free' }
      if (UNITS[n.name]) return { value: UNITS[n.name].value, dim: UNITS[n.name].dim }
      const v = scope(n.name)
      if (!v) throw new ExpressionError(FUNCTIONS.has(n.name) ? `“${n.name}” is a function — it takes its argument in parentheses` : `there is no parameter “${n.name}”`, n.at)
      if (!('dim' in v)) throw new ExpressionError(v.error, n.at)
      return v
    }
    case 'neg': {
      const v = evaluateNode(n.arg, scope)
      return { value: -v.value, dim: v.dim }
    }
    case 'binary': {
      const a = evaluateNode(n.a, scope)
      const b = evaluateNode(n.b, scope)
      switch (n.op) {
        case '+':
          return { value: a.value + b.value, dim: same(a, b, 'be added', n.at) }
        case '-':
          return { value: a.value - b.value, dim: same(a, b, 'be subtracted', n.at) }
        case '*':
          return { value: a.value * b.value, dim: combine(a.dim, b.dim, (x, y) => x + y) }
        case '/':
          if (b.value === 0) throw new ExpressionError('divides by zero', n.at)
          return { value: a.value / b.value, dim: combine(a.dim, b.dim, (x, y) => x - y) }
        case '^':
          if (b.dim !== 'free' && !dimEqual(b.dim, UNITLESS)) throw new ExpressionError(`a power must be a plain number, not ${describeDim(b.dim)}`, n.b.at)
          return { value: Math.pow(a.value, b.value), dim: power(a.dim, b.value, n.at) }
      }
      break
    }
    case 'call':
      return call(n, scope)
  }
  throw new ExpressionError('cannot be read', (n as Node).at)
}

const RAD = Math.PI / 180

function call(n: Extract<Node, { kind: 'call' }>, scope: Scope): Value {
  const args = n.args.map((a) => evaluateNode(a, scope))
  const want = (count: number) => {
    if (args.length !== count) throw new ExpressionError(`${n.name}() takes ${count === 1 ? 'one argument' : `${count} arguments`}`, n.at)
  }
  const angleIn = (v: Value, at: [number, number]): number => {
    if (v.dim !== 'free' && !dimEqual(v.dim, ANGLE) && !dimEqual(v.dim, UNITLESS)) throw new ExpressionError(`${n.name}() takes an angle, not ${describeDim(v.dim)}`, at)
    return v.value * RAD
  }
  const plain = (v: Value, at: [number, number]): number => {
    if (v.dim !== 'free' && !dimEqual(v.dim, UNITLESS)) throw new ExpressionError(`${n.name}() takes a plain number, not ${describeDim(v.dim)}`, at)
    return v.value
  }
  switch (n.name) {
    case 'sin':
      want(1)
      return { value: Math.sin(angleIn(args[0], n.args[0].at)), dim: UNITLESS }
    case 'cos':
      want(1)
      return { value: Math.cos(angleIn(args[0], n.args[0].at)), dim: UNITLESS }
    case 'tan':
      want(1)
      return { value: Math.tan(angleIn(args[0], n.args[0].at)), dim: UNITLESS }
    case 'asin':
      want(1)
      return { value: Math.asin(plain(args[0], n.args[0].at)) / RAD, dim: ANGLE }
    case 'acos':
      want(1)
      return { value: Math.acos(plain(args[0], n.args[0].at)) / RAD, dim: ANGLE }
    case 'atan':
      want(1)
      return { value: Math.atan(plain(args[0], n.args[0].at)) / RAD, dim: ANGLE }
    case 'atan2': {
      want(2)
      same(args[0], args[1], 'be compared in atan2()', n.at)
      return { value: Math.atan2(args[0].value, args[1].value) / RAD, dim: ANGLE }
    }
    case 'sqrt': {
      want(1)
      const v = args[0]
      if (v.value < 0) throw new ExpressionError('sqrt() of a negative number', n.at)
      if (v.dim !== 'free' && (v.dim.mm % 2 !== 0 || v.dim.deg % 2 !== 0)) throw new ExpressionError(`sqrt() of ${describeDim(v.dim)} is no kind of quantity`, n.at)
      return { value: Math.sqrt(v.value), dim: v.dim === 'free' ? 'free' : { mm: v.dim.mm / 2, deg: v.dim.deg / 2 } }
    }
    case 'abs':
      want(1)
      return { value: Math.abs(args[0].value), dim: args[0].dim }
    case 'floor':
      want(1)
      return { value: Math.floor(args[0].value), dim: args[0].dim }
    case 'ceil':
      want(1)
      return { value: Math.ceil(args[0].value), dim: args[0].dim }
    case 'round':
      want(1)
      return { value: Math.round(args[0].value), dim: args[0].dim }
    case 'min':
    case 'max': {
      if (args.length === 0) throw new ExpressionError(`${n.name}() takes at least one argument`, n.at)
      let dim: Dim = args[0].dim
      let value = args[0].value
      for (let i = 1; i < args.length; i++) {
        dim = same({ value, dim }, args[i], `be compared in ${n.name}()`, n.at)
        value = n.name === 'min' ? Math.min(value, args[i].value) : Math.max(value, args[i].value)
      }
      return { value, dim }
    }
    case 'pow': {
      want(2)
      if (args[1].dim !== 'free' && !dimEqual(args[1].dim, UNITLESS)) throw new ExpressionError(`a power must be a plain number, not ${describeDim(args[1].dim)}`, n.args[1].at)
      return { value: Math.pow(args[0].value, args[1].value), dim: power(args[0].dim, args[1].value, n.at) }
    }
  }
  throw new ExpressionError(`there is no function “${n.name}”`, n.at)
}

/** Evaluate an expression against a scope, to whatever kind it comes out
 *  as. */
export function evaluate(src: string, scope: Scope): Evaluated {
  if (src.length > MAX_LENGTH) return { ok: false, error: `is longer than ${MAX_LENGTH} characters`, at: [0, src.length] }
  try {
    const node = new Parser(tokenize(src)).parse()
    const v = evaluateNode(node, scope)
    if (!Number.isFinite(v.value)) return { ok: false, error: 'does not come out as a number', at: node.at }
    return { ok: true, value: v.value, dim: v.dim }
  } catch (e) {
    if (e instanceof ExpressionError) return { ok: false, error: e.message, at: e.at }
    // Parameters reading each other in a chain long enough to run out of
    // stack: an error of the expression, not of the page.
    if (e instanceof RangeError) return { ok: false, error: 'reads parameters too deeply to evaluate', at: [0, src.length] }
    throw e
  }
}

/** Evaluate an expression for a field of the given kind: a bare number is
 *  read in the field's unit, anything of another kind is refused, and for
 *  a whole-number field `whole` asks that the result be one (a parameter
 *  of that kind) rather than rounded (a count field, which rounds). */
export function evaluateFor(src: string, kind: ParameterKind, scope: Scope, opts: { whole?: boolean } = {}): Evaluated {
  const r = evaluate(src, scope)
  if (!r.ok) return r
  const want = dimOfKind(kind)
  if (r.dim !== 'free' && !dimEqual(r.dim, want)) {
    const hint =
      (kind === 'length' || kind === 'angle') && dimEqual(r.dim, UNITLESS)
        // units-ok: expression grammar — the unit words it reads, “10 in” as well
        ? ` — a number with a unit, ${kind === 'length' ? '“10 mm”' : '“10 deg”'}, makes it one`
        : ''
    return { ok: false, error: `comes out as ${describeDim(r.dim)}; ${describeKind(kind)} is wanted here${hint}`, at: [0, src.length] }
  }
  if (kind === 'integer' && opts.whole && !nearInt(r.value)) {
    return { ok: false, error: `comes out ${formatNumber(r.value)}, not whole — round(), floor() or ceil() make it so`, at: [0, src.length] }
  }
  return { ok: true, value: r.value, dim: want }
}

// ---- reading an expression without evaluating it ------------------------------------

/** The parameter names an expression uses, each once, in order of first
 *  use — read off the tokens, so a broken expression still tells. */
export function references(src: string): string[] {
  let tokens: Token[]
  try {
    tokens = tokenize(src)
  } catch {
    tokens = tokenizeLoosely(src)
  }
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind !== 'name' || RESERVED_NAMES.has(t.text)) continue
    const next = tokens[i + 1]
    if (next && next.kind === 'op' && next.text === '(') continue
    if (!out.includes(t.text)) out.push(t.text)
  }
  return out
}

/** The names of an expression the tokenizer refuses: every identifier in
 *  it, so a rename or a count of users does not miss one. */
function tokenizeLoosely(src: string): Token[] {
  const out: Token[] = []
  const re = /[A-Za-z_][A-Za-z0-9_]*|\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m[0] === '(') out.push({ kind: 'op', text: '(', at: [m.index, m.index + 1] })
    else out.push({ kind: 'name', text: m[0], at: [m.index, m.index + m[0].length] })
  }
  out.push({ kind: 'end', at: [src.length, src.length] })
  return out
}

/** The expression with every use of a parameter named `from` written as
 *  `to` — whole names only, so `thread` inside `threadlength` is left be —
 *  and everything else kept exactly as typed. */
export function renameIn(src: string, from: string, to: string): string {
  if (from === to) return src
  let tokens: Token[]
  try {
    tokens = tokenize(src)
  } catch {
    tokens = tokenizeLoosely(src)
  }
  let out = ''
  let last = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind !== 'name' || t.text !== from) continue
    const next = tokens[i + 1]
    if (next && next.kind === 'op' && next.text === '(') continue
    out += src.slice(last, t.at[0]) + to
    last = t.at[1]
  }
  return out + src.slice(last)
}

/** Whether an expression is a bare number and nothing more — what is
 *  stored as a number alone, with no expression kept. */
export function isPlainNumber(src: string): boolean {
  try {
    const tokens = tokenize(src)
    return tokens.length === 2 && tokens[0].kind === 'number'
  } catch {
    // What does not even read as tokens is no plain number.
    return false
  }
}

/** The number a plain-number expression is, or null. */
export function plainNumber(src: string): number | null {
  try {
    const tokens = tokenize(src)
    return tokens.length === 2 && tokens[0].kind === 'number' ? tokens[0].value : null
  } catch {
    // What does not even read as tokens is no plain number.
    return null
  }
}

// ---- words ---------------------------------------------------------------------

/** A number with no zeros carried behind it, to three places. */
function formatNumber(value: number, places = 3): string {
  return String(Number(value.toFixed(places)))
}

/** A value with its unit, as a row reads it: "35 mm", "30°", "6", "0.5" —
 *  a length in the units shown, to a micron in millimetres. */
export function formatValue(value: number, kind: ParameterKind, units: DisplayUnits = 'mm'): string {
  switch (kind) {
    case 'length':
      return `${formatNumber(toDisplay(value, units), lengthDecimals(3, units))} ${unitWord(units)}`
    case 'angle':
      return `${formatNumber(value, 2)}°`
    case 'integer':
      return String(Math.round(value))
    case 'number':
      return formatNumber(value, 4)
  }
}
