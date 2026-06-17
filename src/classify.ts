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

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const QUOTES = new Set(['"', "'", "`"]);

/** First character of a member name (what a chain `.` must be followed by). */
function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch);
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

  // Method/property chain: the `.` member-access points that sit at
  // bracket-depth 0 (outside any call arguments, array, or object). When a line
  // strings several of them together — `foo.bar().baz().qux()` — it's a chain,
  // and the right place to hang wrapped continuations is under the *first* dot,
  // so each wrapped `.method()` stacks under the first one (the way a formatter
  // would break the chain) instead of under the first call's arguments.
  //
  // Dots inside arguments live at depth > 0, so they never count; a lone dot
  // (`obj.method(longArgs)`) isn't a chain and falls through to the bracket
  // rule. We require the dot to be followed by an identifier start so a numeric
  // literal's point (`3.14`) or a spread (`...x`) can't masquerade as a chain.
  let depth = 0;
  let firstChainDotCol = -1;
  let firstChainDotIdx = -1;
  let chainDotCount = 0;
  for (let idx = 0; idx < chars.length; idx++) {
    const c = chars[idx]!;
    if (c.kind !== "code") continue;
    if (OPEN.has(c.ch)) {
      depth++;
    } else if (CLOSE.has(c.ch)) {
      if (depth > 0) depth--;
    } else if (
      depth === 0 &&
      c.ch === "." &&
      isIdentStart(chars[idx + 1]?.ch)
    ) {
      chainDotCount++;
      if (firstChainDotIdx < 0) {
        firstChainDotCol = c.col;
        firstChainDotIdx = idx;
      }
    }
  }
  const isChain = chainDotCount >= 2;

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
