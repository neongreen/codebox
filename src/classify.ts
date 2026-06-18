/**
 * Structural analysis of a highlighted line, derived from Shiki's TextMate
 * token scopes. This is what powers indent-aware wrapping for *every* indented
 * situation — not just leading whitespace, but function arguments, string
 * bodies, and comments — plus comment/string styling.
 *
 * It's a lexer-scope approach (robust to malformed input) rather than a full
 * parse tree; everything here is pure and unit-tested.
 */

export type TokenKind = "code" | "string" | "comment";

/**
 * A finer, parser-oriented role derived from the same TextMate scopes. Where
 * {@link TokenKind} is only what styling needs (code/string/comment), this is
 * what the reflow *parser* needs: it disambiguates the characters that look
 * alike but mean different things — `<` as a generic bracket vs a comparison vs
 * a JSX tag, `?`/`:` ternary vs `?.` optional chaining, `=>` vs `=`, and which
 * operators bind tighter than which. Everything the parser treats as a plain
 * operand (identifiers, numbers, keywords, brackets, …) is left as "operand".
 */
export type TokenRole =
  | "operand" // identifiers, numbers, keywords, brackets, punctuation — operands
  | "op-assign" // =, +=, … (lowest-binding, splits an assignment)
  | "op-ternary" // ? and : of a conditional expression
  | "op-logical" // &&, ||, ??
  | "op-compare" // ==, ===, <, >, <=, instanceof, …
  | "op-additive" // + - (binary)
  | "op-multiplicative" // * / %
  | "op-bitwise" // & | ^ << >> (value-level)
  | "op-type" // | & in a type (union/intersection)
  | "op-other" // any other keyword.operator.* (typeof, in, as, …)
  | "arrow" // =>
  | "accessor" // . or ?. (member access; the chain spine)
  | "comma"
  | "semicolon"
  | "typeparam" // < or > delimiting type arguments / parameters
  | "jsx-punct" // < > / of a JSX tag
  | "jsx-tag"; // a JSX element/attribute name

/**
 * Map a token's TextMate scopes (most-specific last) to a {@link TokenRole}.
 * Strings and comments collapse to "operand" — the parser never looks inside
 * them. Scanned end-first so the innermost scope wins.
 */
export function classifyRole(
  scopes: readonly string[],
  content: string,
): TokenRole {
  for (const s of scopes) {
    if (s.startsWith("comment") || s.startsWith("string")) return "operand";
  }
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i]!;
    if (s.startsWith("storage.type.function.arrow")) return "arrow";
    if (s.startsWith("punctuation.accessor")) return "accessor";
    if (s.startsWith("punctuation.separator.comma")) return "comma";
    if (s.startsWith("punctuation.terminator")) return "semicolon";
    if (s.startsWith("punctuation.definition.typeparameters")) return "typeparam";
    if (s.startsWith("punctuation.definition.tag")) return "jsx-punct";
    if (s.startsWith("entity.name.tag")) return "jsx-tag";
    if (s.startsWith("keyword.operator.ternary")) return "op-ternary";
    if (s.startsWith("keyword.operator.logical")) return "op-logical";
    if (s.startsWith("keyword.operator.assignment")) return "op-assign";
    if (
      s.startsWith("keyword.operator.comparison") ||
      s.startsWith("keyword.operator.relational")
    )
      return "op-compare";
    if (s.startsWith("keyword.operator.arithmetic")) {
      // The grammar lumps + - * / % under one scope; split by glyph so
      // multiplication binds tighter than addition.
      return content === "*" || content === "/" || content === "%"
        ? "op-multiplicative"
        : "op-additive";
    }
    if (s.startsWith("keyword.operator.bitwise")) return "op-bitwise";
    if (s.startsWith("keyword.operator.type")) return "op-type";
    if (s.startsWith("keyword.operator")) return "op-other";
  }
  return "operand";
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const QUOTES = new Set(['"', "'", "`"]);

/** First character of a member name (what a chain `.` must be followed by). */
function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

/** A character carrying only what chain detection needs. */
export interface Cell {
  ch: string;
  kind: TokenKind;
}

/**
 * Find the trailing method/property chain on a line, if any. A chain is a run
 * of `.member` accesses (with their call/index brackets) on a single receiver —
 * `a.b().c().d()`. The run must be *clean*: no other top-level operator (`&&`,
 * `+`, `>`, `=`, `,`, a string literal, …) may sit between its links, or it
 * isn't one chain. We take the maximal such run at the *end* of the line, so
 * `const x = items.filter(f).map(g)` finds `items.filter(f).map(g)` (the
 * assignment prefix is not part of it) while `a.length > 0 && b.active` finds
 * nothing (the `&&` splits the two property accesses).
 *
 * Returns the index where the chain region starts and the indices of its dots,
 * or null when there's no clean chain of at least two links.
 */
export function chainRegion(
  cells: readonly Cell[],
): { start: number; dots: number[] } | null {
  let depth = 0;
  let lastBoundary = -1; // last spot that breaks the chain spine
  const dots: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const { ch, kind } = cells[i]!;
    // A string/comment at top level is a value with operators around it, not
    // part of a member spine — treat it as a boundary.
    if (kind !== "code") {
      if (depth === 0) lastBoundary = i;
      continue;
    }
    if (OPEN.has(ch)) {
      depth++;
      continue;
    }
    if (CLOSE.has(ch)) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue;
    if (ch === "." && isIdentStart(cells[i + 1]?.ch)) {
      dots.push(i);
      continue;
    }
    // Spine-safe characters: identifiers, the dot itself, optional-chaining `?`,
    // non-null `!`, a trailing `;`, and whitespace. Anything else is an operator
    // that ends the trailing chain.
    if (/[A-Za-z0-9_$.?!;]/.test(ch) || ch.trim() === "") continue;
    lastBoundary = i;
  }
  const start = lastBoundary + 1;
  const regionDots = dots.filter((d) => d > lastBoundary);
  if (regionDots.length < 2) return null;
  return { start, dots: regionDots };
}

/** Map a token's TextMate scope list to a coarse kind. */
export function classifyScopes(scopes: readonly string[]): TokenKind {
  for (const s of scopes) {
    if (s.startsWith("comment")) return "comment";
  }
  for (const s of scopes) {
    // Treat string literals as strings, but leave regular expressions as code.
    if (s.startsWith("string") && !s.startsWith("string.regexp")) {
      return "string";
    }
  }
  return "code";
}

export interface CommentLayout {
  /** The comment marker, e.g. "//", "#", "/*", "*". */
  marker: string;
  /** Display column where the comment's text (after the marker) begins. */
  textCol: number;
  /** Display column where the marker itself begins. */
  markerCol: number;
}

export interface LineLayout {
  /**
   * Display column that wrapped continuation lines should align to. Falls back
   * to the leading indent, but aligns under the first argument of an open
   * bracket, under a string body, or under comment text when applicable.
   *
   * This is a *character-column* count; it converts to pixels exactly only in a
   * monospace font (1 col = 1ch). It's the SSR / no-JS fallback indent.
   */
  wrapIndent: number;
  /**
   * Number of leading characters (a raw string index, not a display column)
   * before the alignment anchor, when the anchor is a real structural point —
   * the first argument of a bracket, a string body, or comment text. The
   * renderer measures the pixel width of these characters in the actual font
   * and uses that as the hanging indent, so alignment is correct under *any*
   * typeface — not just monospace. Undefined when the indent is the artificial
   * "one level past the leading indent" fallback (no glyph to align under).
   */
  wrapIndentChars?: number;
  /** Present when the line is or ends with a comment. */
  comment?: CommentLayout;
  /** Present when the line ends inside a string literal (align the body). */
  stringContentCol?: number;
}

interface KindedToken {
  content: string;
  kind: TokenKind;
}

function advance(col: number, ch: string, tabSize: number): number {
  return ch === "\t" ? col + (tabSize - (col % tabSize)) : col + 1;
}

/**
 * Compute the wrap/alignment layout for one line from its kinded tokens.
 */
export function computeLineLayout(
  tokens: readonly KindedToken[],
  leadingIndent: number,
  tabSize = 2,
  continuationIndent?: number,
): LineLayout {
  const contIndent = continuationIndent ?? tabSize;
  // Flatten to characters carrying their kind and display column.
  const chars: { ch: string; kind: TokenKind; col: number }[] = [];
  let col = 0;
  for (const t of tokens) {
    for (const ch of t.content) {
      chars.push({ ch, kind: t.kind, col });
      col = advance(col, ch, tabSize);
    }
  }

  // First opening bracket in code -> align continuations under its first
  // argument. We use the first/outermost bracket (not just unclosed ones)
  // because a fully-balanced call still word-wraps when it's long, and that's
  // exactly when its arguments must not lose their alignment.
  let firstOpenCol = -1;
  let firstOpenIdx = -1;
  for (let idx = 0; idx < chars.length; idx++) {
    const c = chars[idx]!;
    if (c.kind !== "code") continue;
    if (OPEN.has(c.ch)) {
      firstOpenCol = c.col;
      firstOpenIdx = idx;
      break;
    }
  }

  // Method/property chain: when a line ends in a clean run of `.member` calls
  // on one receiver — `foo.bar().baz().qux()` — wrapped continuations should
  // hang under the chain's *first* dot, so each `.method()` stacks under it the
  // way a formatter would break it, rather than under the first call's args.
  // `chainRegion` rejects false positives like `a.length > 0 && b.active` where
  // an operator splits the dots, so this never fires on non-chains.
  const region = chainRegion(chars);
  const isChain = region !== null;
  const firstChainDotIdx = region ? region.dots[0]! : -1;
  const firstChainDotCol = region ? chars[firstChainDotIdx]!.col : -1;

  // First comment on the line (full-line or trailing).
  const firstCommentIdx = chars.findIndex((c) => c.kind === "comment");
  const firstComment =
    firstCommentIdx >= 0 ? chars[firstCommentIdx] : undefined;
  let comment: CommentLayout | undefined;
  let commentTextChars: number | undefined;
  if (firstComment) {
    const markerCol = firstComment.col;
    const rest = chars
      .filter((c) => c.col >= markerCol)
      .map((c) => c.ch)
      .join("");
    const m = /^(\S+)(\s*)/.exec(rest);
    const marker = m ? m[1]! : rest.trim();
    const gap = m ? m[2]!.length : 1;
    comment = {
      marker,
      markerCol,
      textCol: markerCol + marker.length + gap,
    };
    // Character offset of the comment text (markerStart + marker + gap), so the
    // renderer can measure its real pixel position.
    commentTextChars = firstCommentIdx + marker.length + gap;
  }

  // Does the line end inside a string literal? (long value / unterminated)
  let stringContentCol: number | undefined;
  let stringBodyChars: number | undefined;
  const lastNonSpace = [...chars].reverse().find((c) => c.ch.trim() !== "");
  if (lastNonSpace && lastNonSpace.kind === "string") {
    // Walk back to the start of this contiguous string run.
    let startIdx = chars.length - 1;
    while (startIdx > 0 && chars[startIdx - 1]!.kind === "string") startIdx--;
    let contentCol = chars[startIdx]!.col;
    let i = startIdx;
    while (i < chars.length && QUOTES.has(chars[i]!.ch)) {
      contentCol = advance(contentCol, chars[i]!.ch, tabSize);
      i++;
    }
    stringContentCol = contentCol;
    stringBodyChars = i; // raw char index where the body begins
  }

  let wrapIndent: number;
  let wrapIndentChars: number | undefined;
  if (comment) {
    wrapIndent = comment.textCol;
    wrapIndentChars = commentTextChars;
  } else if (stringContentCol !== undefined) {
    wrapIndent = stringContentCol;
    wrapIndentChars = stringBodyChars;
  } else if (isChain) {
    // Align under the first chain dot, so wrapped `.method()` calls stack.
    wrapIndent = firstChainDotCol;
    wrapIndentChars = firstChainDotIdx;
  } else if (firstOpenCol >= 0) {
    wrapIndent = firstOpenCol + 1;
    wrapIndentChars = firstOpenIdx + 1;
  } else {
    wrapIndent = leadingIndent;
    wrapIndentChars = undefined;
  }

  // Rule: a continuation must be indented strictly more than the line's first
  // character. Structural alignment usually satisfies this already; when it
  // doesn't (a plain expression, or a line that is itself string/comment body),
  // fall the continuation in by one indent level so wraps never sit at or left
  // of where the statement began.
  if (wrapIndent <= leadingIndent) {
    wrapIndent = leadingIndent + Math.max(1, contIndent);
    // The fallback indent doesn't sit under any glyph, so there's nothing to
    // measure: the renderer uses the ch-based value.
    wrapIndentChars = undefined;
  }

  return { wrapIndent, wrapIndentChars, comment, stringContentCol };
}
