/**
 * Width-driven reflow of expressions — a small Wadler/Leijen pretty-printer.
 *
 * The renderer everywhere else does Xcode-style *soft* wrapping (CSS, no real
 * line breaks). This module is different: it inserts genuine line breaks into an
 * over-wide expression the way a code formatter (Prettier, Ormolu) would, then
 * lets each produced line still soft-wrap if needed. It only ever relocates
 * whitespace — every non-space character is preserved verbatim, so the
 * displayed code still says exactly what the source said.
 *
 * Two layers:
 *  - A recursive-descent **parse** (see `buildExpr`) over the scoped token
 *    stream splits at the loosest-binding construct first — assignment, then
 *    arrow, ternary, then the lowest-precedence binary-operator chain — and
 *    bottoms out at a "primary" (a member chain `a.b().c()` or a run of text +
 *    bracket groups). Bracket contents recurse back through it, so operators
 *    *inside* a call or array break too. It is driven entirely by each token's
 *    `role` (classify.ts), so a generic `<` is never mistaken for a comparison
 *    and a ternary `?` never for `?.`. Malformed input just yields fewer break
 *    points — it never throws.
 *  - The classic best/fits **layout** lays each group flat when it fits the
 *    remaining width and broken otherwise, descending into child groups only
 *    when they still overflow ("break the least, at the outermost level").
 *
 * Pure and unit-tested; the React layer measures the width and calls in.
 */

import { chainRegion, type TokenKind, type TokenRole } from "./classify";
import { leadingIndentWidth } from "./indent";
import type { CodeLine, CodeToken } from "./types";

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** A single character carrying the style of the token it came from. */
interface Atom {
  ch: string;
  color?: string;
  bgColor?: string;
  fontStyle?: number;
  kind: TokenKind;
  /** Parser role inherited from the source token (see {@link TokenRole}). */
  role: TokenRole;
}

function toAtoms(tokens: readonly CodeToken[]): Atom[] {
  const atoms: Atom[] = [];
  for (const t of tokens) {
    for (const ch of t.content) {
      atoms.push({
        ch,
        color: t.color,
        bgColor: t.bgColor,
        fontStyle: t.fontStyle,
        kind: t.kind,
        role: t.role ?? "operand",
      });
    }
  }
  return atoms;
}

/** Re-coalesce a run of atoms into the minimal list of like-styled tokens. */
function atomsToTokens(atoms: readonly Atom[]): CodeToken[] {
  const out: CodeToken[] = [];
  for (const a of atoms) {
    const last = out[out.length - 1];
    if (
      last &&
      last.color === a.color &&
      last.bgColor === a.bgColor &&
      last.fontStyle === a.fontStyle &&
      last.kind === a.kind
    ) {
      last.content += a.ch;
    } else {
      out.push({
        content: a.ch,
        color: a.color,
        bgColor: a.bgColor,
        fontStyle: a.fontStyle,
        kind: a.kind,
      });
    }
  }
  return out;
}

// --- Document model -------------------------------------------------------

type Doc =
  | { t: "text"; atoms: Atom[] }
  /** A break point. Flat: renders `flat` (the source whitespace it stands in
   *  for, usually empty or a single space). Broken: a newline + indentation. */
  | { t: "line"; flat: Atom[] }
  | { t: "concat"; parts: Doc[] }
  | { t: "nest"; indent: number; doc: Doc }
  | { t: "group"; doc: Doc };

const isSpace = (a: Atom) => a.ch.trim() === "";

/**
 * How the layout measures width. `measure` returns the rendered pixel width of
 * a run of atoms (so a line that mixes the monospace code font with a
 * proportional prose-string font is measured correctly, not assumed uniform).
 * `spacePx` is the width of one indentation space. The defaults — 1px per atom,
 * 1px per space — make widths read as plain character columns, which keeps the
 * pure layout unit-testable without any font.
 */
export interface Measurer {
  measure: (atoms: readonly Atom[]) => number;
  spacePx: number;
}

const COLUMN_MEASURER: Measurer = {
  measure: (atoms) => atoms.length,
  spacePx: 1,
};

/** Index of the bracket that matches the opener at `i`, or `hi-1` if unmatched. */
function matchClose(atoms: Atom[], i: number, hi: number): number {
  let depth = 0;
  for (let j = i; j < hi; j++) {
    const a = atoms[j]!;
    if (a.kind !== "code") continue;
    if (OPEN.has(a.ch)) depth++;
    else if (CLOSE.has(a.ch)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return hi - 1;
}

/** Nesting change for the bracket/grouping at `a`: `()[]{}` count, and so do
 *  type-argument angle brackets (a `<`/`>` with the `typeparam` role — never a
 *  comparison `<`, which keeps role `op-compare`). Everything else is 0. This is
 *  what lets every depth-0 scan below see inside `Map<K, V>` as one unit. */
function bracketDelta(a: Atom): number {
  if (a.kind !== "code") return 0;
  if (OPEN.has(a.ch) || (a.role === "typeparam" && a.ch === "<")) return 1;
  if (CLOSE.has(a.ch) || (a.role === "typeparam" && a.ch === ">")) return -1;
  return 0;
}

/** Index of the `>` that closes a type-argument list opened by the `<` at `i`
 *  (both `typeparam`-roled), or -1 if unterminated. */
function matchTypeParam(atoms: Atom[], i: number, hi: number): number {
  let depth = 0;
  for (let j = i; j < hi; j++) {
    const a = atoms[j]!;
    if (a.kind !== "code" || a.role !== "typeparam") continue;
    if (a.ch === "<") depth++;
    else if (a.ch === ">") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// --- Precedence-aware expression parsing ----------------------------------
//
// The builders below form a small recursive-descent pretty-printer over the
// scoped token stream. `buildExpr` is the entry: it splits a range at the
// loosest-binding construct it finds (assignment, then arrow, ternary, then
// the lowest-precedence binary-operator chain), recursing into each operand,
// and bottoms out at a "primary" (a member chain or a run of text + bracket
// groups). Because bracket contents route back through `buildExpr` (via
// `buildItems`), operators *inside* a call or array break too. Everything is
// driven by `role` (see classify.ts), so a generic `<` never looks like a
// comparison and a ternary `?` never looks like `?.`. It only relocates
// whitespace and tolerates malformed input — an unmatched bracket or a missing
// operand just yields fewer break points, never a throw.

/** Trim leading/trailing whitespace atoms from a range, returning the inner
 *  [s,e). */
function trimRange(atoms: Atom[], lo: number, hi: number): [number, number] {
  let s = lo;
  let e = hi;
  while (s < e && isSpace(atoms[s]!)) s++;
  while (e > s && isSpace(atoms[e - 1]!)) e--;
  return [s, e];
}

/** Index just past an optional arrow header `… =>` at the start of [lo,hi), or
 *  `lo` when the region doesn't open with one. Used so a hugged callback keeps
 *  `(args) =>` on the opening line. */
function arrowHeaderEnd(atoms: Atom[], lo: number, hi: number): number {
  let depth = 0;
  for (let i = lo; i < hi; i++) {
    const a = atoms[i]!;
    if (a.kind !== "code") continue;
    if (OPEN.has(a.ch)) depth++;
    else if (CLOSE.has(a.ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && a.role === "arrow") {
      let j = i;
      while (j < hi && atoms[j]!.role === "arrow") j++; // span the whole `=>`
      while (j < hi && isSpace(atoms[j]!)) j++;
      return j;
    }
  }
  return lo;
}

/** Precedence rank of a binary operator role (lower binds looser → break it
 *  first). Non-binary roles return null. Assignment, arrow and ternary are
 *  handled separately, not here. */
function binaryRank(role: TokenRole): number | null {
  switch (role) {
    case "op-logical":
    case "op-type":
      return 1;
    case "op-compare":
      return 2;
    case "op-bitwise":
      return 3;
    case "op-additive":
      return 4;
    case "op-multiplicative":
      return 5;
    default:
      return null;
  }
}

interface OpSpan {
  start: number;
  end: number;
  rank: number;
}

/**
 * Binary operator spans at depth 0 in [lo,hi), excluding *unary* uses (an
 * operator with no value to its left, e.g. a leading `-` or `!`). Walks tracking
 * whether the previous significant token produced a value, so `a - -b` finds one
 * operator, not two.
 */
function topLevelBinaryOps(atoms: Atom[], lo: number, hi: number): OpSpan[] {
  const spans: OpSpan[] = [];
  let depth = 0;
  let lastWasValue = false;
  let i = lo;
  while (i < hi) {
    const a = atoms[i]!;
    if (a.kind !== "code") {
      lastWasValue = true; // a string/comment is a value
      i++;
      continue;
    }
    const d = bracketDelta(a);
    if (d !== 0) {
      depth = Math.max(0, depth + d);
      if (depth === 0 && d < 0) lastWasValue = true; // a bracketed primary is a value
      i++;
      continue;
    }
    if (depth === 0 && isTagPunct(a, "<")) {
      i = matchJsxElement(atoms, i, hi) + 1; // a JSX element is one value
      lastWasValue = true;
      continue;
    }
    if (depth !== 0 || isSpace(a)) {
      i++;
      continue;
    }
    const rank = binaryRank(a.role);
    if (rank !== null) {
      let j = i;
      while (j < hi && atoms[j]!.kind === "code" && binaryRank(atoms[j]!.role) === rank)
        j++;
      if (lastWasValue) spans.push({ start: i, end: j, rank });
      lastWasValue = false;
      i = j;
      continue;
    }
    lastWasValue = true; // an identifier/number/keyword/other operand
    i++;
  }
  return spans;
}

/** First depth-0 index in [lo,hi) whose atom satisfies `match`, or -1. JSX
 *  elements are skipped whole — operators inside a tag are not top level. */
function firstTopLevel(
  atoms: Atom[],
  lo: number,
  hi: number,
  match: (a: Atom) => boolean,
): number {
  let depth = 0;
  for (let i = lo; i < hi; i++) {
    const a = atoms[i]!;
    const d = bracketDelta(a);
    if (d !== 0) {
      depth = Math.max(0, depth + d);
      continue;
    }
    if (depth === 0 && isTagPunct(a, "<")) {
      i = matchJsxElement(atoms, i, hi);
      continue;
    }
    if (depth === 0 && match(a)) return i;
  }
  return -1;
}

/** Does a JSX element begin at depth 0 in [lo,hi)? (A raw scan — unlike the
 *  other scanners it must *not* skip JSX, it is what detects it.) */
function hasTopLevelJsx(atoms: Atom[], lo: number, hi: number): boolean {
  let depth = 0;
  for (let i = lo; i < hi; i++) {
    const a = atoms[i]!;
    const d = bracketDelta(a);
    if (d !== 0) {
      depth = Math.max(0, depth + d);
      continue;
    }
    if (depth === 0 && isTagPunct(a, "<")) return true;
  }
  return false;
}

/** Index of the first depth-0 JSX element opener `<` in [lo,hi), or -1. */
function firstJsx(atoms: Atom[], lo: number, hi: number): number {
  let depth = 0;
  for (let i = lo; i < hi; i++) {
    const a = atoms[i]!;
    const d = bracketDelta(a);
    if (d !== 0) {
      depth = Math.max(0, depth + d);
      continue;
    }
    if (depth === 0 && isTagPunct(a, "<")) return i;
  }
  return -1;
}

/**
 * Build the breakable document for the expression in [lo,hi). Splits at the
 * loosest construct present and recurses; bottoms out at {@link buildPrimary}.
 */
function buildExpr(atoms: Atom[], lo: number, hi: number, indentUnit: number): Doc {
  if (lo >= hi) return { t: "text", atoms: [] };
  // A JSX element is its own grammar; parse it before any operator splitting so
  // attribute `=` and tag `<`/`>` aren't mistaken for assignment/comparison.
  // (The operator scanners below skip JSX elements whole, so a wrapping ternary
  // or assignment is still found correctly; bare/leading JSX is caught here.)
  if (startsJsx(atoms, lo, hi)) return buildJsx(atoms, lo, hi, indentUnit);

  // Loosest, right-associative constructs: pick the leftmost of assignment,
  // arrow and ternary — whichever opens first is the outer structure
  // (`x => a ? b : c` is an arrow; `a ? x => b : c` is a conditional).
  const assignIdx = firstTopLevel(atoms, lo, hi, (a) => a.role === "op-assign");
  const arrowIdx = firstTopLevel(atoms, lo, hi, (a) => a.role === "arrow");
  const ternIdx = firstTopLevel(
    atoms,
    lo,
    hi,
    (a) => a.role === "op-ternary" && a.ch === "?",
  );
  const lowest = [assignIdx, arrowIdx, ternIdx].filter((x) => x >= 0);
  if (lowest.length) {
    const at = Math.min(...lowest);
    if (at === assignIdx) return buildAssign(atoms, lo, at, hi, indentUnit);
    if (at === arrowIdx) return buildArrow(atoms, lo, at, hi, indentUnit);
    return buildTernary(atoms, lo, at, hi, indentUnit);
  }

  // Binary chain: break at the lowest-precedence operator level present.
  const ops = topLevelBinaryOps(atoms, lo, hi);
  if (ops.length) {
    const minRank = Math.min(...ops.map((o) => o.rank));
    return buildBinary(
      atoms,
      lo,
      hi,
      ops.filter((o) => o.rank === minRank),
      indentUnit,
    );
  }

  return buildPrimary(atoms, lo, hi, indentUnit);
}

/** Is this range a bare binary-operator chain (no looser ternary/arrow/assign
 *  wrapping it)? Such a right-hand side reads best broken *under* the `=`. A
 *  ternary keeps its condition on the `=` line, and a member chain / call / arrow
 *  keeps sitting on it too — so only this case triggers the break-after-`=`. */
function isBinaryExpr(atoms: Atom[], lo: number, hi: number): boolean {
  if (hasTopLevelJsx(atoms, lo, hi)) return false;
  const looser =
    firstTopLevel(atoms, lo, hi, (a) => a.role === "op-assign") >= 0 ||
    firstTopLevel(atoms, lo, hi, (a) => a.role === "arrow") >= 0 ||
    firstTopLevel(atoms, lo, hi, (a) => a.role === "op-ternary" && a.ch === "?") >=
      0;
  if (looser) return false;
  return topLevelBinaryOps(atoms, lo, hi).length > 0;
}

/**
 * `lhs = rhs`. A member-chain/call/arrow/ternary right-hand side stays on the
 * `=` line and breaks internally (`const x = source\n  .filter(…)`,
 * `const c = cond\n  ? a\n  : b`). A bare operator-chain right-hand side instead
 * breaks *after* the `=` and indents, so every operand gets the full width
 * (`const ok =\n  a.length > 0 &&\n  …`).
 */
function buildAssign(
  atoms: Atom[],
  lo: number,
  eqIdx: number,
  hi: number,
  indentUnit: number,
): Doc {
  let assignEnd = eqIdx;
  while (assignEnd < hi && atoms[assignEnd]!.role === "op-assign") assignEnd++;
  let bodyStart = assignEnd;
  while (bodyStart < hi && isSpace(atoms[bodyStart]!)) bodyStart++;
  const [rs, re] = trimRange(atoms, bodyStart, hi);

  if (isBinaryExpr(atoms, rs, re)) {
    return {
      t: "concat",
      parts: [
        { t: "text", atoms: atoms.slice(lo, assignEnd) },
        {
          t: "group",
          doc: {
            t: "nest",
            indent: indentUnit,
            doc: {
              t: "concat",
              parts: [
                { t: "line", flat: atoms.slice(assignEnd, bodyStart) },
                buildExpr(atoms, rs, re, indentUnit),
              ],
            },
          },
        },
      ],
    };
  }
  return {
    t: "concat",
    parts: [
      { t: "text", atoms: atoms.slice(lo, bodyStart) },
      buildExpr(atoms, rs, re, indentUnit),
    ],
  };
}

/** `(params) => body`: parameters stay flat on the line; the body breaks (and,
 *  when it is a bracket, hugs onto the `=>` line). */
function buildArrow(
  atoms: Atom[],
  lo: number,
  arrowIdx: number,
  hi: number,
  indentUnit: number,
): Doc {
  let bodyStart = arrowIdx;
  while (bodyStart < hi && atoms[bodyStart]!.role === "arrow") bodyStart++;
  while (bodyStart < hi && isSpace(atoms[bodyStart]!)) bodyStart++;
  const [bs, be] = trimRange(atoms, bodyStart, hi);
  return {
    t: "concat",
    parts: [
      { t: "text", atoms: atoms.slice(lo, bodyStart) },
      buildExpr(atoms, bs, be, indentUnit),
    ],
  };
}

/** `cond ? then : else`, broken Prettier-style with `?`/`:` starting each
 *  continuation. */
function buildTernary(
  atoms: Atom[],
  lo: number,
  qIdx: number,
  hi: number,
  indentUnit: number,
): Doc {
  // Find the `:` matching this `?`, skipping nested conditionals.
  let depth = 0;
  let nested = 0;
  let colon = -1;
  for (let i = qIdx + 1; i < hi; i++) {
    const a = atoms[i]!;
    const d = bracketDelta(a);
    if (d !== 0) {
      depth = Math.max(0, depth + d);
      continue;
    }
    if (depth === 0 && isTagPunct(a, "<")) {
      i = matchJsxElement(atoms, i, hi);
      continue;
    }
    if (depth === 0 && a.role === "op-ternary") {
      if (a.ch === "?") nested++;
      else if (a.ch === ":") {
        if (nested === 0) {
          colon = i;
          break;
        }
        nested--;
      }
    }
  }
  if (colon < 0) return buildPrimary(atoms, lo, hi, indentUnit); // malformed

  const [cs, ce] = trimRange(atoms, lo, qIdx);
  const qWsStart = (() => {
    let k = qIdx + 1;
    while (k < hi && isSpace(atoms[k]!)) k++;
    return k;
  })();
  const [ts, te] = trimRange(atoms, qWsStart, colon);
  const colWsStart = (() => {
    let k = colon + 1;
    while (k < hi && isSpace(atoms[k]!)) k++;
    return k;
  })();
  const [es, ee] = trimRange(atoms, colWsStart, hi);

  const wsBeforeQ = atoms.slice(ce, qIdx);
  const wsBeforeColon = atoms.slice(te, colon);
  return {
    t: "concat",
    parts: [
      buildExpr(atoms, cs, ce, indentUnit),
      {
        t: "group",
        doc: {
          t: "nest",
          indent: indentUnit,
          doc: {
            t: "concat",
            parts: [
              { t: "line", flat: wsBeforeQ },
              { t: "text", atoms: atoms.slice(qIdx, qWsStart) },
              buildExpr(atoms, ts, te, indentUnit),
              { t: "line", flat: wsBeforeColon },
              { t: "text", atoms: atoms.slice(colon, colWsStart) },
              buildExpr(atoms, es, ee, indentUnit),
            ],
          },
        },
      },
    ],
  };
}

/**
 * A left-associative binary chain at one precedence level, broken one operand
 * per line with the operator trailing each line (`a &&` / `b &&` / `c`). All
 * operands sit at the *same* indent — the breaking container (a bracket's
 * interior or an assignment's broken right-hand side) supplies the one level of
 * indentation, so logical conditions in an `if (…)` and the operands of a
 * broken `=` both line up rather than stair-stepping.
 */
function buildBinary(
  atoms: Atom[],
  lo: number,
  hi: number,
  ops: OpSpan[],
  indentUnit: number,
): Doc {
  const [hs, he] = trimRange(atoms, lo, ops[0]!.start);
  const parts: Doc[] = [
    buildExpr(atoms, hs, he, indentUnit),
    {
      t: "text",
      atoms: [...atoms.slice(he, ops[0]!.start), ...atoms.slice(ops[0]!.start, ops[0]!.end)],
    },
  ];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    let ws = op.end;
    while (ws < hi && isSpace(atoms[ws]!)) ws++;
    const operandEnd = k + 1 < ops.length ? ops[k + 1]!.start : hi;
    const [os, oe] = trimRange(atoms, ws, operandEnd);
    parts.push({ t: "line", flat: atoms.slice(op.end, ws) });
    parts.push(buildExpr(atoms, os, oe, indentUnit));
    if (k + 1 < ops.length) {
      const next = ops[k + 1]!;
      parts.push({
        t: "text",
        atoms: [...atoms.slice(oe, next.start), ...atoms.slice(next.start, next.end)],
      });
    }
  }
  return { t: "group", doc: { t: "concat", parts } };
}

/**
 * A primary: a trailing member chain `a.b().c()` broken one `.link` per line,
 * or otherwise a flat run of text and independently-breakable bracket groups.
 */
function buildPrimary(atoms: Atom[], lo: number, hi: number, indentUnit: number): Doc {
  // JSX reached as a primary (e.g. `return <App … />`): emit the prefix text,
  // then parse the element. Operators never sit between the prefix and the tag
  // (those split higher up), so the prefix is plain text.
  const jsx = firstJsx(atoms, lo, hi);
  if (jsx >= 0) {
    const parts: Doc[] = [];
    if (jsx > lo) parts.push({ t: "text", atoms: atoms.slice(lo, jsx) });
    parts.push(buildJsx(atoms, jsx, hi, indentUnit));
    return parts.length === 1 ? parts[0]! : { t: "concat", parts };
  }
  const region = chainRegion(atoms.slice(lo, hi));
  // Only a chain with at least one *call* breaks; pure property access
  // (`user.profile.settings`) stays intact, the way a formatter leaves it.
  const hasCall =
    !!region &&
    region.dots.some((d) => {
      let k = lo + d;
      while (k < hi && atoms[k]!.role === "accessor") k++; // skip this link's dot
      for (; k < hi; k++) {
        const a = atoms[k]!;
        if (a.kind !== "code") continue;
        if (a.ch === "(") return true;
        if (a.role === "accessor") break; // reached the next link
      }
      return false;
    });
  if (region && region.dots.length >= 2 && hasCall) {
    const start = lo + region.start;
    const dots = region.dots.map((d) => lo + d);
    const prefix = buildSeq(atoms, lo, start, indentUnit);
    const head = buildSeq(atoms, start, dots[0]!, indentUnit);
    const links: Doc[] = [];
    for (let d = 0; d < dots.length; d++) {
      const from = dots[d]!;
      const to = d + 1 < dots.length ? dots[d + 1]! : hi;
      links.push({ t: "line", flat: [] });
      links.push(buildSeq(atoms, from, to, indentUnit));
    }
    const chain: Doc = {
      t: "group",
      doc: {
        t: "concat",
        parts: [
          head,
          { t: "nest", indent: indentUnit, doc: { t: "concat", parts: links } },
        ],
      },
    };
    return { t: "concat", parts: [prefix, chain] };
  }
  return buildSeq(atoms, lo, hi, indentUnit);
}

// --- JSX -------------------------------------------------------------------

/** First non-whitespace index in [lo,hi), or hi. */
function firstSignificant(atoms: Atom[], lo: number, hi: number): number {
  let i = lo;
  while (i < hi && isSpace(atoms[i]!)) i++;
  return i;
}

/** Does [lo,hi) begin with a JSX element opener `<Tag`? */
function startsJsx(atoms: Atom[], lo: number, hi: number): boolean {
  const i = firstSignificant(atoms, lo, hi);
  return (
    i < hi &&
    atoms[i]!.kind === "code" &&
    atoms[i]!.role === "jsx-punct" &&
    atoms[i]!.ch === "<"
  );
}

/** A JSX-tag `<`/`>` at brace depth 0 (not one buried in a `{expr}` attribute
 *  or child). */
function isTagPunct(a: Atom, ch: string): boolean {
  return a.kind === "code" && a.role === "jsx-punct" && a.ch === ch;
}

/**
 * Index of the final `>` that closes the JSX element opened by the `<` at `lo`,
 * matching nested elements and self-closing tags. Returns `hi-1` if unbalanced
 * (tolerant — a partial element still lays out).
 */
function matchJsxElement(atoms: Atom[], lo: number, hi: number): number {
  let i = lo;
  let depth = 0;
  let brace = 0;
  while (i < hi) {
    const a = atoms[i]!;
    if (a.kind === "code" && OPEN.has(a.ch)) {
      brace++;
      i++;
      continue;
    }
    if (a.kind === "code" && CLOSE.has(a.ch)) {
      if (brace > 0) brace--;
      i++;
      continue;
    }
    if (brace === 0 && isTagPunct(a, "<")) {
      const closing = i + 1 < hi && atoms[i + 1]!.ch === "/"; // `</`
      // Walk to this tag's own `>` (skipping any `{…}` attribute values).
      let j = i + 1;
      let b = 0;
      while (j < hi) {
        const x = atoms[j]!;
        if (x.kind === "code" && OPEN.has(x.ch)) b++;
        else if (x.kind === "code" && CLOSE.has(x.ch)) {
          if (b > 0) b--;
        } else if (b === 0 && isTagPunct(x, ">")) break;
        j++;
      }
      if (closing) {
        depth = Math.max(0, depth - 1);
        if (depth === 0) return j;
      } else {
        let p = j - 1;
        while (p > i && isSpace(atoms[p]!)) p--;
        const selfClose = p > i && atoms[p]!.ch === "/";
        if (!selfClose) depth++;
        if (depth === 0) return j; // top-level self-close
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return hi - 1;
}

/** Split a JSX attribute region into attribute ranges, breaking only at
 *  code-kind whitespace at brace depth 0 (so `title="a b"` stays one attr). */
function splitJsxAttrs(atoms: Atom[], lo: number, hi: number): [number, number][] {
  const attrs: [number, number][] = [];
  let i = lo;
  while (i < hi) {
    while (i < hi && isSpace(atoms[i]!)) i++;
    if (i >= hi) break;
    const s = i;
    let depth = 0;
    while (i < hi) {
      const a = atoms[i]!;
      if (a.kind === "code" && OPEN.has(a.ch)) depth++;
      else if (a.kind === "code" && CLOSE.has(a.ch)) {
        if (depth > 0) depth--;
      } else if (depth === 0 && a.kind === "code" && isSpace(a)) break;
      i++;
    }
    attrs.push([s, i]);
  }
  return attrs;
}

/**
 * Lay out one JSX element `<Tag …>children</Tag>` (or `<Tag … />`). The element
 * is one group: it stays inline when it fits, and when it doesn't, attributes
 * break one per line, the `>` dedents, children indent, and the closing tag
 * dedents — the shape a formatter produces. Children recurse: nested elements
 * via this function, `{expr}` containers via {@link buildExpr}.
 */
function buildJsxElement(atoms: Atom[], lo: number, hi: number, indentUnit: number): Doc {
  // Opening tag: `<` then the tag-name run, then attributes up to this tag's `>`.
  let openGt = lo + 1;
  let b = 0;
  while (openGt < hi) {
    const x = atoms[openGt]!;
    if (x.kind === "code" && OPEN.has(x.ch)) b++;
    else if (x.kind === "code" && CLOSE.has(x.ch)) {
      if (b > 0) b--;
    } else if (b === 0 && isTagPunct(x, ">")) break;
    openGt++;
  }
  if (openGt >= hi) return { t: "text", atoms: atoms.slice(lo, hi) }; // malformed

  let tagNameEnd = lo + 1;
  while (tagNameEnd < openGt && atoms[tagNameEnd]!.role === "jsx-tag")
    tagNameEnd++;

  // Self-closing? (a `/` just before the `>`). `closerStart` is the `/` or `>`.
  let beforeGt = openGt - 1;
  while (beforeGt > lo && isSpace(atoms[beforeGt]!)) beforeGt--;
  const selfClose = atoms[beforeGt]!.ch === "/";
  const closerStart = selfClose ? beforeGt : openGt;
  // Whitespace right before the closer (kept as the break point's flat text, so
  // `<Tag a />` keeps its space and `<Tag a>` does not invent one).
  let wsB = closerStart;
  while (wsB > tagNameEnd && isSpace(atoms[wsB - 1]!)) wsB--;

  const attrs = splitJsxAttrs(atoms, tagNameEnd, wsB);
  // No attributes: keep the whole opening tag intact (`<List>`, `<br />`).
  const openTag: Doc[] =
    attrs.length === 0
      ? [{ t: "text", atoms: atoms.slice(lo, openGt + 1) }]
      : (() => {
          const attrParts: Doc[] = [];
          for (const [s, e] of attrs) {
            attrParts.push({
              t: "line",
              flat: [{ ch: " ", kind: "code", role: "operand" }],
            });
            attrParts.push(buildExpr(atoms, s, e, indentUnit));
          }
          return [
            { t: "text", atoms: atoms.slice(lo, tagNameEnd) },
            { t: "nest", indent: indentUnit, doc: { t: "concat", parts: attrParts } },
            { t: "line", flat: atoms.slice(wsB, closerStart) },
            { t: "text", atoms: atoms.slice(closerStart, openGt + 1) },
          ];
        })();

  if (selfClose) {
    return openTag.length === 1
      ? openTag[0]!
      : { t: "group", doc: { t: "concat", parts: openTag } };
  }

  // Children + closing tag. The closing tag is the `</…>` ending at `hi-1`.
  let closeStart = hi - 1;
  while (closeStart > openGt && !isTagPunct(atoms[closeStart]!, "<")) closeStart--;
  if (atoms[closeStart]!.ch !== "<") closeStart = openGt + 1; // malformed

  const childParts = buildJsxChildren(atoms, openGt + 1, closeStart, indentUnit);
  return {
    t: "group",
    doc: {
      t: "concat",
      parts: [
        ...openTag,
        { t: "nest", indent: indentUnit, doc: { t: "concat", parts: childParts } },
        { t: "line", flat: [] },
        { t: "text", atoms: atoms.slice(closeStart, hi) },
      ],
    },
  };
}

/**
 * Children of a JSX element. The block always opens on its own indented line
 * (the leading break). Text runs stay literal and `{expr}` containers stay
 * inline with the surrounding text (`Save {label}` stays together), while each
 * nested *element* — block-level content — gets its own break so siblings stack.
 */
function buildJsxChildren(atoms: Atom[], lo: number, hi: number, indentUnit: number): Doc[] {
  const parts: Doc[] = [{ t: "line", flat: [] }]; // children open on a new line
  let i = lo;
  let buf: Atom[] = [];
  let firstUnit = true;
  const flushText = () => {
    if (buf.length) {
      parts.push({ t: "text", atoms: buf });
      buf = [];
    }
  };
  while (i < hi) {
    const a = atoms[i]!;
    if (isTagPunct(a, "<")) {
      flushText();
      if (!firstUnit) parts.push({ t: "line", flat: [] });
      const end = matchJsxElement(atoms, i, hi);
      parts.push(buildJsxElement(atoms, i, end + 1, indentUnit));
      firstUnit = false;
      i = end + 1;
      continue;
    }
    if (a.kind === "code" && a.ch === "{") {
      flushText();
      const close = matchClose(atoms, i, hi);
      parts.push(buildBracket(atoms, i, close, indentUnit)); // inline expression
      firstUnit = false;
      i = close + 1;
      continue;
    }
    if (!isSpace(a)) firstUnit = false;
    buf.push(a);
    i++;
  }
  flushText();
  return parts;
}

/** Entry for a JSX expression: the element, plus any trailing text (e.g. `;`). */
function buildJsx(atoms: Atom[], lo: number, hi: number, indentUnit: number): Doc {
  const start = firstSignificant(atoms, lo, hi);
  const elEnd = matchJsxElement(atoms, start, hi);
  const parts: Doc[] = [];
  if (start > lo) parts.push({ t: "text", atoms: atoms.slice(lo, start) });
  parts.push(buildJsxElement(atoms, start, elEnd + 1, indentUnit));
  if (elEnd + 1 < hi) parts.push({ t: "text", atoms: atoms.slice(elEnd + 1, hi) });
  return parts.length === 1 ? parts[0]! : { t: "concat", parts };
}

/** Top-level comma-separated segment ranges in [lo,hi) (commas excluded). JSX
 *  and bracket interiors are skipped. */
function topLevelCommaSegments(atoms: Atom[], lo: number, hi: number): [number, number][] {
  const segs: [number, number][] = [];
  let depth = 0;
  let start = lo;
  let i = lo;
  while (i < hi) {
    const a = atoms[i]!;
    const d = bracketDelta(a);
    if (d !== 0) {
      depth = Math.max(0, depth + d);
      i++;
      continue;
    }
    if (depth === 0 && isTagPunct(a, "<")) {
      i = matchJsxElement(atoms, i, hi) + 1;
      continue;
    }
    if (depth === 0 && a.kind === "code" && a.role === "comma") {
      segs.push([start, i]);
      start = i + 1;
    }
    i++;
  }
  segs.push([start, hi]);
  return segs;
}

/** Index of the `([{` matching the close at `closeIdx`, scanning back to `lo`. */
function backwardMatchOpen(atoms: Atom[], closeIdx: number, lo: number): number {
  let depth = 0;
  for (let j = closeIdx; j >= lo; j--) {
    const a = atoms[j]!;
    if (a.kind !== "code") continue;
    if (CLOSE.has(a.ch)) depth++;
    else if (OPEN.has(a.ch)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * Is [lo,hi) a "huggable" last argument — an object/array literal, or a callback
 * whose block body is an object/array/block — that should expand onto the
 * call's opening line (`render(x, [` … `])`)? It must end with `}`/`]` whose
 * matching open is reached through only a simple header (a callee path or an
 * arrow `=>`), never across an operator.
 */
function isHuggableLast(atoms: Atom[], lo: number, hi: number): boolean {
  if (hi <= lo) return false;
  const close = atoms[hi - 1]!;
  if (!(close.kind === "code" && (close.ch === "}" || close.ch === "]"))) return false;
  const open = backwardMatchOpen(atoms, hi - 1, lo);
  if (open < 0) return false;
  if (topLevelBinaryOps(atoms, lo, open).length > 0) return false;
  if (firstTopLevel(atoms, lo, open, (a) => a.role === "op-ternary") >= 0) return false;
  return true;
}

/**
 * Comma- (and, in a `{}` block, semicolon-) separated items, each an expression
 * that breaks on its own. Used for the contents of a bracket group.
 */
function buildItems(
  atoms: Atom[],
  lo: number,
  hi: number,
  semi: boolean,
  indentUnit: number,
): Doc {
  const parts: Doc[] = [];
  let segStart = lo;
  let depth = 0;
  let i = lo;
  const pushSeg = (s: number, e: number, sep: Atom[], breakAfter: boolean) => {
    const [ts, te] = trimRange(atoms, s, e);
    const segDoc = buildExpr(atoms, ts, te, indentUnit);
    if (breakAfter) {
      parts.push({ t: "concat", parts: [segDoc, { t: "text", atoms: sep }] });
    } else {
      parts.push(
        sep.length ? { t: "concat", parts: [segDoc, { t: "text", atoms: sep }] } : segDoc,
      );
    }
  };
  while (i < hi) {
    const a = atoms[i]!;
    const d = bracketDelta(a);
    if (d !== 0) {
      depth = Math.max(0, depth + d);
      i++;
      continue;
    }
    if (depth === 0 && isTagPunct(a, "<")) {
      i = matchJsxElement(atoms, i, hi) + 1; // JSX child/value is one unit
      continue;
    }
    const isSep =
      depth === 0 &&
      a.kind === "code" &&
      (a.role === "comma" || (semi && a.role === "semicolon"));
    if (isSep) {
      let j = i + 1;
      while (j < hi && isSpace(atoms[j]!)) j++;
      const ws = atoms.slice(i + 1, j);
      if (j < hi) {
        pushSeg(segStart, i, [a], true);
        parts.push({ t: "line", flat: ws });
      } else {
        // Trailing separator: keep it (and its whitespace) inline; no blank line.
        pushSeg(segStart, i, [a, ...ws], false);
      }
      segStart = j;
      i = j;
      continue;
    }
    i++;
  }
  if (segStart < hi) pushSeg(segStart, hi, [], false);
  return parts.length === 1 ? parts[0]! : { t: "concat", parts };
}

/**
 * Build the doc for a single bracket group `atoms[openIdx..closeIdx]`,
 * applying Prettier-style *hugging*: when a bracket's whole content is (after an
 * optional `(args) =>` arrow header) a single nested bracket group that runs to
 * the end, the brackets collapse onto shared lines — `map((r) => ({` … `}))`
 * instead of stair-stepping each `(` and `{` onto its own deeper-indented line.
 * Only the innermost group introduces an indent level and breaks its items.
 */
function buildBracket(
  atoms: Atom[],
  openIdx: number,
  closeIdx: number,
  indentUnit: number,
): Doc {
  const openersAtoms: Atom[] = []; // text that stays on the opening line
  const closersAtoms: Atom[] = []; // closers for the last line, inner-first
  const midTrail: Atom[] = []; // whitespace from hugged-over levels
  let curOpen = openIdx;
  let curClose = closeIdx;
  let innerOpenChar = atoms[openIdx]!.ch;
  let innerS = openIdx + 1;
  let innerE = openIdx + 1;
  let innerLead: Atom[] = [];
  let innerTrail: Atom[] = [];
  let hasInnerCloser = false;

  while (true) {
    const cAtom = atoms[curClose];
    const cHas = !!cAtom && CLOSE.has(cAtom.ch) && cAtom.kind === "code";
    openersAtoms.push(atoms[curOpen]!);
    innerOpenChar = atoms[curOpen]!.ch;
    // Content of this bracket, trimmed of the whitespace touching the brackets.
    let s = curOpen + 1;
    let e = cHas ? curClose : curClose + 1; // unmatched: content runs to the end
    const lead: Atom[] = [];
    while (s < e && isSpace(atoms[s]!)) lead.push(atoms[s++]!);
    const trail: Atom[] = [];
    while (e > s && isSpace(atoms[e - 1]!)) trail.unshift(atoms[--e]!);

    // Empty bracket: nothing to break around, render as flat text.
    if (s >= e) {
      if (cHas) closersAtoms.unshift(cAtom!);
      return {
        t: "text",
        atoms: [...openersAtoms, ...lead, ...trail, ...closersAtoms],
      };
    }

    const h = arrowHeaderEnd(atoms, s, e);
    const canHug =
      cHas &&
      h < e &&
      atoms[h]!.kind === "code" &&
      OPEN.has(atoms[h]!.ch) &&
      atoms[e - 1]!.kind === "code" &&
      CLOSE.has(atoms[e - 1]!.ch) &&
      matchClose(atoms, h, e) === e - 1;

    if (canHug) {
      // Fold the opener + arrow header onto the opening line; descend into the
      // single child bracket and try to hug it too.
      closersAtoms.unshift(cAtom!);
      openersAtoms.push(...lead, ...atoms.slice(s, h));
      midTrail.unshift(...trail);
      curOpen = h;
      curClose = e - 1;
      continue;
    }

    // Innermost breakable content reached. We do NOT fold an arrow header here:
    // unlike the hug path, the content may have sibling items after the arrow
    // body (e.g. `setTimeout(() => {…}, 1000)`), so the header stays with the
    // items and `buildItems`/`buildExpr` keeps `(args) => {` together itself.
    innerLead = lead;
    innerS = s;
    innerE = e;
    innerTrail = trail;
    hasInnerCloser = cHas;
    if (cHas) closersAtoms.unshift(cAtom!);
    break;
  }

  // Last-argument hugging: `render(x, [` … `])`. When a call's final argument
  // is an object/array literal (or block-bodied callback) and the earlier
  // arguments are simple, keep the earlier ones flat on the opening line and let
  // only the last argument expand — instead of one-argument-per-line. Skipped
  // when an earlier argument is itself a callback (it should hug instead), so
  // `useEffect(() => {…}, deps)` still breaks its callback.
  if (hasInnerCloser && innerOpenChar === "(") {
    const segs = topLevelCommaSegments(atoms, innerS, innerE);
    if (segs.length >= 2) {
      const [ls, le] = trimRange(atoms, segs[segs.length - 1]![0], innerE);
      const prefixHasCallback = segs
        .slice(0, -1)
        .some(([s, e]) => firstTopLevel(atoms, s, e, (a) => a.role === "arrow") >= 0);
      if (!prefixHasCallback && isHuggableLast(atoms, ls, le)) {
        return {
          t: "concat",
          parts: [
            { t: "text", atoms: [...openersAtoms, ...innerLead, ...atoms.slice(innerS, ls)] },
            buildExpr(atoms, ls, le, indentUnit),
            { t: "text", atoms: [...innerTrail, ...midTrail, ...closersAtoms] },
          ],
        };
      }
    }
  }

  // `{}` is a block or object: break on `;` as well as `,`.
  const items = buildItems(
    atoms,
    innerS,
    innerE,
    innerOpenChar === "{",
    indentUnit,
  );
  const inner: Doc = {
    t: "nest",
    indent: indentUnit,
    doc: { t: "concat", parts: [{ t: "line", flat: innerLead }, items] },
  };
  const closeParts: Doc[] = hasInnerCloser
    ? [
        { t: "line", flat: innerTrail },
        { t: "text", atoms: [...midTrail, ...closersAtoms] },
      ]
    : []; // unmatched: nothing to close with
  return {
    t: "concat",
    parts: [
      { t: "text", atoms: openersAtoms },
      { t: "group", doc: { t: "concat", parts: [inner, ...closeParts] } },
    ],
  };
}

/**
 * A flat run of atoms with each bracket pair turned into an independently
 * breakable group (via {@link buildBracket}). No separator or operator breaks
 * happen here — those are decided one level up, in {@link buildExpr} /
 * {@link buildItems}; this is the leaf that lays out a primary's text and its
 * call/index brackets.
 */
/** Is a template interpolation's content [lo,hi) worth breaking — i.e. does it
 *  contain a top-level operator, ternary/arrow/assignment, comma, or a bracket
 *  group? A bare identifier or member access is not, and stays inline. */
function isCompoundInterp(atoms: Atom[], lo: number, hi: number): boolean {
  const [s, e] = trimRange(atoms, lo, hi);
  if (s >= e) return false;
  if (topLevelBinaryOps(atoms, s, e).length > 0) return true;
  if (
    firstTopLevel(
      atoms,
      s,
      e,
      (a) =>
        a.role === "op-ternary" ||
        a.role === "arrow" ||
        a.role === "op-assign" ||
        a.role === "comma",
    ) >= 0
  )
    return true;
  for (let i = s; i < e; i++) {
    const a = atoms[i]!;
    if (a.kind === "code" && OPEN.has(a.ch)) return true;
  }
  return false;
}

function buildSeq(atoms: Atom[], lo: number, hi: number, indentUnit: number): Doc {
  const parts: Doc[] = [];
  let buf: Atom[] = [];
  const flush = () => {
    if (buf.length) {
      parts.push({ t: "text", atoms: buf });
      buf = [];
    }
  };

  let i = lo;
  while (i < hi) {
    const a = atoms[i]!;
    if (a.kind === "code" && OPEN.has(a.ch)) {
      const close = matchClose(atoms, i, hi);
      // A template-literal interpolation `${…}` (a code `{` right after a code
      // `$`) only breaks when its expression is actually compound — a bare
      // `${count}` or `${user.name}` stays inline rather than ballooning onto
      // its own line.
      const isInterp =
        a.ch === "{" &&
        i > lo &&
        atoms[i - 1]!.kind === "code" &&
        atoms[i - 1]!.ch === "$";
      if (isInterp && !isCompoundInterp(atoms, i + 1, close)) {
        for (let k = i; k <= close; k++) buf.push(atoms[k]!);
        i = close + 1;
        continue;
      }
      flush();
      parts.push(buildBracket(atoms, i, close, indentUnit));
      i = close + 1;
      continue;
    }
    if (a.kind === "code" && a.role === "typeparam" && a.ch === "<") {
      const close = matchTypeParam(atoms, i, hi);
      if (close > i) {
        flush();
        parts.push(buildTypeArgs(atoms, i, close, indentUnit));
        i = close + 1;
        continue;
      }
    }
    buf.push(a);
    i++;
  }
  flush();
  return parts.length === 1 ? parts[0]! : { t: "concat", parts };
}

/**
 * A type-argument list `<A, B, …>`: a breakable group like a call's `(`, with
 * each argument on its own line when it overflows. Distinguished from a
 * comparison purely by token role, so `a < b` never lands here.
 */
function buildTypeArgs(
  atoms: Atom[],
  openIdx: number,
  closeIdx: number,
  indentUnit: number,
): Doc {
  const [s, e] = trimRange(atoms, openIdx + 1, closeIdx);
  if (s >= e) {
    return { t: "text", atoms: atoms.slice(openIdx, closeIdx + 1) };
  }
  const items = buildItems(atoms, s, e, false, indentUnit);
  return {
    t: "concat",
    parts: [
      { t: "text", atoms: [atoms[openIdx]!] },
      {
        t: "group",
        doc: {
          t: "concat",
          parts: [
            {
              t: "nest",
              indent: indentUnit,
              doc: {
                t: "concat",
                parts: [{ t: "line", flat: atoms.slice(openIdx + 1, s) }, items],
              },
            },
            { t: "line", flat: atoms.slice(e, closeIdx) },
            { t: "text", atoms: [atoms[closeIdx]!] },
          ],
        },
      },
    ],
  };
}

// --- Layout (Wadler/Leijen best/fits) -------------------------------------

interface Item {
  indent: number;
  mode: "flat" | "break";
  doc: Doc;
}

/** Does what's on the current line fit in `remaining` pixels? Stack is in
 *  pop-order (last element is processed first), matching `best`. */
function fits(remaining: number, stack: Item[], m: Measurer): boolean {
  let r = remaining;
  const items = stack.slice();
  while (r >= 0) {
    const it = items.pop();
    if (!it) return true;
    const { indent, mode, doc } = it;
    switch (doc.t) {
      case "text":
        r -= m.measure(doc.atoms);
        break;
      case "line":
        if (mode === "flat") r -= m.measure(doc.flat);
        else return true; // a real newline: everything up to here fit
        break;
      case "concat":
        for (let k = doc.parts.length - 1; k >= 0; k--)
          items.push({ indent, mode, doc: doc.parts[k]! });
        break;
      case "nest":
        items.push({ indent: indent + doc.indent, mode, doc: doc.doc });
        break;
      case "group":
        // Keep the ambient mode rather than forcing flat: a *following* group
        // that will break (its newline ends this fit check) means a small group
        // like `(r)` no longer breaks just because a later structure overflows.
        // The candidate group is pushed by `best` as its contents already in
        // flat mode, so it is still measured flat.
        items.push({ indent, mode, doc: doc.doc });
        break;
    }
  }
  return false;
}

type Out = { type: "text"; atoms: Atom[] } | { type: "nl"; indent: number };

function best(maxWidth: number, baseIndent: number, doc: Doc, m: Measurer): Out[] {
  const out: Out[] = [];
  // `col` is tracked in pixels; `indent` is a column count, so a newline costs
  // `indent` spaces at `spacePx` each.
  let col = 0;
  const stack: Item[] = [{ indent: baseIndent, mode: "break", doc }];
  while (stack.length) {
    const { indent, mode, doc: d } = stack.pop()!;
    switch (d.t) {
      case "text":
        out.push({ type: "text", atoms: d.atoms });
        col += m.measure(d.atoms);
        break;
      case "concat":
        for (let k = d.parts.length - 1; k >= 0; k--)
          stack.push({ indent, mode, doc: d.parts[k]! });
        break;
      case "nest":
        stack.push({ indent: indent + d.indent, mode, doc: d.doc });
        break;
      case "group": {
        const trial = stack.slice();
        trial.push({ indent, mode: "flat", doc: d.doc });
        const flat = fits(maxWidth - col, trial, m);
        stack.push({ indent, mode: flat ? "flat" : "break", doc: d.doc });
        break;
      }
      case "line":
        if (mode === "flat") {
          out.push({ type: "text", atoms: d.flat });
          col += m.measure(d.flat);
        } else {
          out.push({ type: "nl", indent });
          col = indent * m.spacePx;
        }
        break;
    }
  }
  return out;
}

/** Count leading whitespace atoms (the line's own indentation). */
function leadingWS(atoms: Atom[]): number {
  let n = 0;
  while (n < atoms.length && isSpace(atoms[n]!)) n++;
  return n;
}

export interface ReflowResult {
  /** True when the line was a chain and got reformatted (possibly to 1 line). */
  reflowed: boolean;
  /** Visual lines, each as a token list ready to render. */
  lines: CodeToken[][];
}

export interface ReflowOptions {
  /** Columns a continuation indents per level. Default 2. */
  indentUnit?: number;
  /** Pixel measurer. Defaults to character columns (font-free, for tests). */
  measurer?: Measurer;
}

/**
 * Reformat one source line to fit `maxWidth` (in the measurer's units — pixels
 * with a real measurer, columns with the default). A `.`-chain breaks one call
 * per line; any other line with a bracketed group (call args, array, object,
 * import list) breaks that group one item per line when it overflows. Lines
 * that fit, or have nothing breakable, come back as a single line unchanged.
 * Only whitespace is relocated; no other character is altered.
 */
export function reflowLine(
  tokens: readonly CodeToken[],
  maxWidth: number,
  { indentUnit = 2, measurer = COLUMN_MEASURER }: ReflowOptions = {},
): ReflowResult {
  const atoms = toAtoms(tokens);
  // A chain reformats around its dots; anything else reflows around its
  // brackets (buildSeq turns each `(`/`[`/`{` group into a breakable group).
  const doc = buildExpr(atoms, 0, atoms.length, indentUnit);

  const base = leadingWS(atoms);
  const outs = best(maxWidth, base, doc, measurer);

  const lines: Atom[][] = [[]];
  for (const o of outs) {
    if (o.type === "text") {
      if (o.atoms.length) lines[lines.length - 1]!.push(...o.atoms);
    } else {
      const indent: Atom[] = [];
      for (let s = 0; s < o.indent; s++)
        indent.push({ ch: " ", kind: "code", role: "operand" });
      lines.push(indent);
    }
  }
  // "Reflowed" only when we actually broke the line into more than one visual
  // line; a line that stayed flat is returned untouched by the caller.
  return { reflowed: lines.length > 1, lines: lines.map(atomsToTokens) };
}

/**
 * Reflow a source line into one or more render-ready {@link CodeLine}s.
 *
 * A reflowed sub-line is already laid out to fit, so it gets a *plain* layout
 * that hangs only at its own leading indent — NOT the structural bracket/chain
 * anchor `computeLineLayout` would pick. That anchor (e.g. under the `(` at the
 * end of an opener line like `compute(`) would shrink the line box and make an
 * already-fitting line word-wrap mid-identifier. Lines that don't reflow come
 * back unchanged, with their original structural layout.
 */
export function reflowSourceLine(
  line: CodeLine,
  maxWidth: number,
  tabSize: number,
  measurer?: Measurer,
): CodeLine[] {
  const r = reflowLine(line.tokens, maxWidth, { indentUnit: tabSize, measurer });
  if (!r.reflowed || r.lines.length <= 1) return [line];
  return r.lines.map((tokens) => {
    const text = tokens.map((t) => t.content).join("");
    const indent = leadingIndentWidth(text, tabSize);
    return {
      text,
      indent,
      tokens,
      layout: { wrapIndent: indent },
    };
  });
}

/** Test helper: render a reflow as plain text (newlines + indentation). */
export function reflowToString(
  tokens: readonly CodeToken[],
  maxWidth: number,
  indentUnit = 2,
): string {
  return reflowLine(tokens, maxWidth, { indentUnit })
    .lines.map((toks) => toks.map((t) => t.content).join(""))
    .join("\n");
}

/** The atom type and the column measurer, exposed for the renderer to build a
 *  font-aware {@link Measurer}. */
export type { Atom };
