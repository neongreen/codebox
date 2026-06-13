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
const QUOTES = new Set(['"', "'", "`"]);

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
   */
  wrapIndent: number;
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
  for (const c of chars) {
    if (c.kind !== "code") continue;
    if (OPEN.has(c.ch)) {
      firstOpenCol = c.col;
      break;
    }
  }

  // First comment on the line (full-line or trailing).
  const firstComment = chars.find((c) => c.kind === "comment");
  let comment: CommentLayout | undefined;
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
  }

  // Does the line end inside a string literal? (long value / unterminated)
  let stringContentCol: number | undefined;
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
  }

  let wrapIndent: number;
  if (comment) wrapIndent = comment.textCol;
  else if (stringContentCol !== undefined) wrapIndent = stringContentCol;
  else if (firstOpenCol >= 0) wrapIndent = firstOpenCol + 1;
  else wrapIndent = leadingIndent;

  // Rule: a continuation must be indented strictly more than the line's first
  // character. Structural alignment usually satisfies this already; when it
  // doesn't (a plain expression, or a line that is itself string/comment body),
  // fall the continuation in by one indent level so wraps never sit at or left
  // of where the statement began.
  if (wrapIndent <= leadingIndent) {
    wrapIndent = leadingIndent + Math.max(1, contIndent);
  }

  return { wrapIndent, comment, stringContentCol };
}
