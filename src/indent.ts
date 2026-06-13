import type { CSSProperties } from "react";

/**
 * Measure the leading-indent width of a line in display columns.
 * Spaces count as 1; tabs advance to the next multiple of `tabSize`.
 */
export function leadingIndentWidth(line: string, tabSize = 2): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ") {
      width += 1;
    } else if (ch === "\t") {
      width += tabSize - (width % tabSize);
    } else {
      break;
    }
  }
  return width;
}

/**
 * Per-line CSS that implements Xcode-style indent-aware soft wrapping.
 *
 * The trick: a hanging indent of `indent + hangingIndent` columns. A negative
 * `text-indent` pulls the FIRST visual line back to column 0 (so the line's own
 * leading whitespace still renders normally), while `padding-left` pushes every
 * WRAPPED continuation line in to line up under the code. With hangingIndent 0
 * the wrap aligns exactly under the first non-whitespace character.
 *
 * When `wrap` is false we render with `pre` (no wrapping) and let the container
 * scroll horizontally — indentation is preserved trivially in that case.
 */
export function lineStyle(
  indent: number,
  hangingIndent: number,
  wrap: boolean,
): CSSProperties {
  if (!wrap) {
    return { whiteSpace: "pre" };
  }
  const total = Math.max(0, indent + hangingIndent);
  return {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    paddingLeft: `${total}ch`,
    textIndent: `${-total}ch`,
  };
}
