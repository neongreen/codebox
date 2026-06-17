/**
 * Width-driven reflow of `.`-chains — a small Wadler/Leijen pretty-printer.
 *
 * The renderer everywhere else does Xcode-style *soft* wrapping (CSS, no real
 * line breaks). This module is different: it inserts genuine line breaks into a
 * method/property chain when the chain doesn't fit the available width, the way
 * a code formatter (Prettier, Ormolu) would. It only ever relocates whitespace
 * — every non-space character is preserved verbatim, so the displayed code
 * still says exactly what the source said.
 *
 * The algorithm is the classic pretty-printer: the chain is a *group*, each
 * call's `(...)` is a nested group, and a group is laid flat if it fits the
 * remaining width or broken otherwise — descending into child groups only when
 * they still overflow. That yields "break the least, at the outermost level"
 * behaviour: a chain that doesn't fit breaks one call per line, but each call's
 * arguments stay on their line unless that single call is itself too wide.
 *
 * Pure and unit-tested; the React layer measures the width and calls in.
 */

import { chainRegion, type TokenKind } from "./classify";
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

/**
 * Build a doc for a flat run of atoms, turning each bracket pair into a nested,
 * independently-breakable group. When `commaBreaks` is set, top-level commas
 * become break points too (argument lists). Chain dots are handled one level up.
 */
function buildSeq(
  atoms: Atom[],
  lo: number,
  hi: number,
  indentUnit: number,
  commaBreaks: boolean,
): Doc {
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
      buf.push(a); // the opening bracket stays attached to what precedes it
      flush();
      // Whitespace just inside the brackets rides along with the break points
      // so it disappears cleanly when we break and is preserved when we don't.
      let s = i + 1;
      const leadWS: Atom[] = [];
      while (s < close && isSpace(atoms[s]!)) leadWS.push(atoms[s++]!);
      let e = close;
      const trailWS: Atom[] = [];
      while (e > s && isSpace(atoms[e - 1]!)) trailWS.unshift(atoms[--e]!);
      const closeAtom = atoms[close];
      // An empty (or whitespace-only) bracket has nothing to break around;
      // emit it as plain text so an overflowing line can't explode `()` into
      // three lines. Whitespace inside is preserved verbatim.
      if (s >= e) {
        const flat = [...leadWS, ...trailWS];
        if (closeAtom && CLOSE.has(closeAtom.ch) && closeAtom.kind === "code")
          flat.push(closeAtom);
        buf.push(...flat);
        flush();
        i = close + 1;
        continue;
      }
      const inner = buildSeq(atoms, s, e, indentUnit, true);
      const closeDoc: Doc[] =
        closeAtom && CLOSE.has(closeAtom.ch) && closeAtom.kind === "code"
          ? [{ t: "line", flat: trailWS }, { t: "text", atoms: [closeAtom] }]
          : []; // unmatched: nothing to close with
      parts.push({
        t: "group",
        doc: {
          t: "concat",
          parts: [
            { t: "nest", indent: indentUnit, doc: { t: "concat", parts: [{ t: "line", flat: leadWS }, inner] } },
            ...closeDoc,
          ],
        },
      });
      i = close + 1;
      continue;
    }

    if (commaBreaks && a.kind === "code" && a.ch === ",") {
      buf.push(a);
      flush();
      const ws: Atom[] = [];
      let j = i + 1;
      while (j < hi && isSpace(atoms[j]!)) ws.push(atoms[j++]!);
      parts.push({ t: "line", flat: ws });
      i = j;
      continue;
    }

    buf.push(a);
    i++;
  }
  flush();
  return parts.length === 1 ? parts[0]! : { t: "concat", parts };
}

/**
 * Build the doc for a chain line: any prefix before the chain (e.g. `const x =`)
 * stays put, then the chain is a group — head receiver, then each `.link` behind
 * its own break point. Returns null when the line isn't a clean chain.
 */
function buildChain(atoms: Atom[], indentUnit: number): Doc | null {
  const region = chainRegion(atoms);
  if (!region) return null;
  const { start, dots } = region;
  const prefix = buildSeq(atoms, 0, start, indentUnit, false);
  const head = buildSeq(atoms, start, dots[0]!, indentUnit, false);
  const links: Doc[] = [];
  for (let d = 0; d < dots.length; d++) {
    const from = dots[d]!;
    const to = d + 1 < dots.length ? dots[d + 1]! : atoms.length;
    links.push({ t: "line", flat: [] });
    links.push(buildSeq(atoms, from, to, indentUnit, false));
  }
  const chain: Doc = {
    t: "group",
    doc: {
      t: "concat",
      parts: [head, { t: "nest", indent: indentUnit, doc: { t: "concat", parts: links } }],
    },
  };
  return { t: "concat", parts: [prefix, chain] };
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
  const doc =
    buildChain(atoms, indentUnit) ??
    buildSeq(atoms, 0, atoms.length, indentUnit, false);

  const base = leadingWS(atoms);
  const outs = best(maxWidth, base, doc, measurer);

  const lines: Atom[][] = [[]];
  for (const o of outs) {
    if (o.type === "text") {
      if (o.atoms.length) lines[lines.length - 1]!.push(...o.atoms);
    } else {
      const indent: Atom[] = [];
      for (let s = 0; s < o.indent; s++) indent.push({ ch: " ", kind: "code" });
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
