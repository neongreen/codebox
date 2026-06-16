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
 * The indent length is `var(--codebox-wrap-indent, <ch fallback>)`. The
 * fallback — `indent` columns expressed in `ch` — is what SSR emits and is
 * exact for monospace fonts. After mount the renderer measures the anchor
 * glyph's real pixel offset in the actual font and sets `--codebox-wrap-indent`
 * on the line, so alignment is correct under *any* typeface (proportional,
 * ligatured, mixed) rather than assuming 1 column == 1ch.
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
  // Cap the hanging indent so a deep alignment can never starve the
  // continuation of width (otherwise a deeply-nested call in a narrow box wraps
  // one character per line). The cap is a *length* (container-query width unit,
  // not a percentage): a percentage resolves against different bases for
  // padding-left vs text-indent, which would stop them cancelling and push the
  // first line out of flush. With a length, both resolve identically, so the
  // first visual line always starts at column 0. `--codebox-max-wrap` defaults
  // to 66cqw (66% of the codebox's own inline size).
  const indentLen = `var(--codebox-wrap-indent, ${total}ch)`;
  const capped = `min(${indentLen}, var(--codebox-max-wrap, 66cqw))`;
  return {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    paddingLeft: capped,
    textIndent: `calc(-1 * ${capped})`,
  };
}
