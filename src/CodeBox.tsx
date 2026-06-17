import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { TokenKind } from "./classify";
import { highlightToLines } from "./highlight";
import { lineStyle } from "./indent";
import type {
  CodeBoxProps,
  CodeLine,
  CodeToken,
  HighlightedCode,
  RenderedCodeProps,
  TokenStyles,
} from "./types";

// useLayoutEffect warns during SSR; fall back to useEffect there.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** The caret position (left/top) at `offset` within `node`. */
function caretAt(node: Text, offset: number): { left: number; top: number } {
  const r = document.createRange();
  r.setStart(node, offset);
  r.setEnd(node, offset);
  const rect = r.getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

/**
 * Measure the anchor's horizontal offset: how far the first `charCount`
 * characters advance, in whatever font is actually applied. The first visual
 * line is flush, so that advance is exactly where continuations must hang to.
 *
 * We take the difference between two collapsed carets (start of line and the
 * anchor) rather than a range's bounding box: a range that spans several token
 * spans under a large negative text-indent reports a bogus union width that
 * tracks padding-left, which would feed back into the hanging indent it sets
 * and ramp without converging. Carets give the pure glyph advance, immune to
 * padding — exact for proportional fonts, ligatures and tabs alike.
 *
 * Returns null when the anchor has wrapped onto a later visual line (no single
 * offset to align to — the cap governs there) or there's nothing to measure.
 * Comment-marker overlays (injected after the text) are skipped.
 */
function measurePrefixPx(el: HTMLElement, charCount: number): number | null {
  if (charCount <= 0) return 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
        if (p.classList.contains("codebox__comment-marker")) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
  }
  if (nodes.length === 0) return null;

  let remaining = charCount;
  let endNode = nodes[nodes.length - 1]!;
  let endOffset = endNode.length;
  for (const node of nodes) {
    if (remaining <= node.length) {
      endNode = node;
      endOffset = remaining;
      break;
    }
    remaining -= node.length;
  }

  const start = caretAt(nodes[0]!, 0);
  const end = caretAt(endNode, endOffset);
  // Anchor wrapped onto a later line: nothing to align to here.
  if (Math.abs(end.top - start.top) > 1) return null;
  return Math.max(0, end.left - start.left);
}

// One offscreen canvas, reused across all measurements.
let measureCanvas: HTMLCanvasElement | null = null;

/**
 * The x-height of `family` per 1px of font-size, measured via canvas glyph
 * metrics — subpixel accurate and font-resolution exact (the canvas resolves
 * the family list the same way the page does). We measure the actual bounding
 * box of "x": its ascent above the baseline *is* the x-height, since "x" has no
 * ascender or descender. Scale-invariant, so we measure at a large reference
 * size for precision and divide it back out. Returns null when metrics aren't
 * available (very old engines) or the glyph has no box.
 */
function xHeightPerPx(family: string, weight: string, style: string): number | null {
  if (typeof document === "undefined") return null;
  const canvas = (measureCanvas ??= document.createElement("canvas"));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const ref = 256;
  ctx.font = `${style} ${weight} ${ref}px ${family}`;
  const ascent = ctx.measureText("x").actualBoundingBoxAscent;
  if (typeof ascent !== "number" || !(ascent > 0)) return null;
  return ascent / ref;
}

/**
 * Measure the code and prose fonts and return a px font-size for the prose font
 * that gives it the *same x-height* as the code font, so a proportional string
 * body looks the same size as the surrounding monospace instead of smaller.
 * Returns a `--codebox-prose-font-size-measured` value (px) or undefined.
 *
 * This only sets the *measured* variable; a user-supplied
 * `--codebox-prose-font-size` still wins via the cascade in styles.css, so an
 * explicit override is respected and never overwritten here. Re-measures on
 * resize (the box / font-size can change) and after web fonts swap in.
 */
function useProseFontSizeVar(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): string | undefined {
  const [value, setValue] = useState<string | undefined>(undefined);

  useIsoLayoutEffect(() => {
    if (!enabled) {
      setValue((prev) => (prev === undefined ? prev : undefined));
      return;
    }
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const cs = getComputedStyle(el);
      const proseFamily = cs.getPropertyValue("--codebox-prose-font").trim();
      if (!proseFamily) return;
      const sizePx = parseFloat(cs.fontSize);
      if (!(sizePx > 0)) return;
      // Same weight/style for both so we compare only the typefaces.
      const codeX = xHeightPerPx(cs.fontFamily, cs.fontWeight, cs.fontStyle);
      const proseX = xHeightPerPx(proseFamily, cs.fontWeight, cs.fontStyle);
      if (codeX == null || proseX == null) return;
      // Round to 0.01px: getComputedStyle / measureText jitter in the last
      // decimals, and an ever-changing value would defeat the equality guard.
      const px = Math.round((sizePx * (codeX / proseX)) * 100) / 100;
      const next = `${px}px`;
      setValue((prev) => (prev === next ? prev : next));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let cancelled = false;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [ref, enabled]);

  return value;
}

/**
 * Measure the anchor's pixel offset and return a value for the
 * `--codebox-wrap-indent` custom property (with any `hangingIndent` columns
 * added on in `ch`). Re-measures on resize and after web fonts load. Returns
 * undefined when there's nothing to measure (no structural anchor, wrap off, or
 * not yet mounted), in which case the CSS `ch` fallback in `lineStyle` applies.
 */
function useWrapIndentVar(
  ref: RefObject<HTMLElement | null>,
  charCount: number | undefined,
  hangingIndent: number,
  enabled: boolean,
): string | undefined {
  const [value, setValue] = useState<string | undefined>(undefined);

  useIsoLayoutEffect(() => {
    if (!enabled || charCount == null) {
      setValue((prev) => (prev === undefined ? prev : undefined));
      return;
    }
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const raw = measurePrefixPx(el, charCount);
      if (raw == null) return;
      // Round to a half-pixel: getBoundingClientRect jitters in the last
      // decimals, and feeding an ever-so-different value back every render would
      // never satisfy the equality guard below (an infinite update loop). The
      // measured width is otherwise padding-independent, so this converges in
      // one step. Half-pixel keeps alignment crisp without churn.
      const px = Math.round(raw * 2) / 2;
      const next =
        hangingIndent > 0 ? `calc(${px}px + ${hangingIndent}ch)` : `${px}px`;
      setValue((prev) => (prev === next ? prev : next));
    };

    measure();
    // Re-measure when the line resizes (container width, font size) and once
    // web fonts finish loading and swap in.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let cancelled = false;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [ref, charCount, hangingIndent, enabled]);

  return value;
}

/** Merge the measured hanging-indent custom property into a line's style. */
function withWrapIndent(
  style: CSSProperties,
  wrapVar: string | undefined,
): CSSProperties {
  if (!wrapVar) return style;
  return { ...style, ["--codebox-wrap-indent"]: wrapVar } as CSSProperties;
}

function tokenStyle(token: CodeToken, overrides?: TokenStyles): CSSProperties {
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.bgColor) style.backgroundColor = token.bgColor;
  const fs = token.fontStyle;
  if (fs && fs > 0) {
    if (fs & 1) style.fontStyle = "italic";
    if (fs & 2) style.fontWeight = "bold";
    if (fs & 4) style.textDecoration = "underline";
  }
  return { ...style, ...(overrides?.[token.kind] ?? {}) };
}

function tokenClass(kind: TokenKind, prose: boolean): string {
  let c = `codebox__tok codebox__tok--${kind}`;
  if (kind === "string" && prose) c += " codebox__tok--prose";
  return c;
}

function classNames(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

function Tokens({
  tokens,
  proseStrings,
  tokenStyles,
  renderToken,
}: {
  tokens: CodeToken[];
  proseStrings: boolean;
  tokenStyles?: TokenStyles;
  renderToken?: (token: CodeToken, index: number) => ReactNode;
}) {
  if (tokens.length === 0) return "\n";
  return tokens.map((token, j) =>
    renderToken ? (
      <Fragment key={j}>{renderToken(token, j)}</Fragment>
    ) : (
      <span
        key={j}
        className={tokenClass(token.kind, proseStrings)}
        style={tokenStyle(token, tokenStyles)}
      >
        {token.content}
      </span>
    ),
  );
}

function sameNums(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Comment content that repeats its marker (//, #, …) at the start of each
 * wrapped continuation line. Pure CSS can't repeat content per wrap, so we
 * measure the visual line positions and overlay markers. SSR renders the marker
 * once; the overlay is a client-side enhancement.
 */
function CommentContent({
  contentStyle,
  marker,
  markerColor,
  wrapIndentChars,
  hangingIndent,
  wrap,
  children,
}: {
  contentStyle: CSSProperties;
  marker: string;
  markerColor?: string;
  wrapIndentChars?: number;
  hangingIndent: number;
  wrap: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tops, setTops] = useState<number[]>([]);
  const [left, setLeft] = useState(0);
  const wrapVar = useWrapIndentVar(ref, wrapIndentChars, hangingIndent, wrap);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();

      // Align repeated markers exactly under the real marker on line 1.
      const commentTok = el.querySelector(".codebox__tok--comment");
      const firstRect = commentTok?.getClientRects()[0];
      const markerLeft = firstRect ? firstRect.left - base.left : 0;

      // Measure visual lines from the text token spans only — never the overlay
      // markers we inject, otherwise the count would drift on re-measure.
      const tops: number[] = [];
      el.querySelectorAll(".codebox__tok").forEach((tok) => {
        for (const r of tok.getClientRects()) {
          if (r.width > 0.5) tops.push(Math.round(r.top));
        }
      });
      const uniqueTops = [...new Set(tops)].sort((a, b) => a - b);
      // Skip the first visual line — it already has the real marker.
      const next = uniqueTops.slice(1).map((t) => t - base.top);
      setLeft((prev) => (prev === markerLeft ? prev : markerLeft));
      setTops((prev) => (sameNums(prev, next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // No dep array on purpose: re-measure after every render (e.g. width/theme
    // changes). The equality guards above make this converge without a loop.
  });

  return (
    <span
      ref={ref}
      className="codebox__content codebox__content--comment"
      style={withWrapIndent({ position: "relative", ...contentStyle }, wrapVar)}
    >
      {children}
      {tops.map((top, k) => (
        <span
          key={k}
          aria-hidden="true"
          className="codebox__comment-marker"
          style={{ position: "absolute", top, left, color: markerColor }}
        >
          {marker}
        </span>
      ))}
    </span>
  );
}

/** Non-comment line content that measures its own structural hanging indent. */
function PlainContent({
  contentStyle,
  wrapIndentChars,
  hangingIndent,
  wrap,
  children,
}: {
  contentStyle: CSSProperties;
  wrapIndentChars?: number;
  hangingIndent: number;
  wrap: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const wrapVar = useWrapIndentVar(ref, wrapIndentChars, hangingIndent, wrap);
  return (
    <span
      ref={ref}
      className="codebox__content"
      style={withWrapIndent(contentStyle, wrapVar)}
    >
      {children}
    </span>
  );
}

function Line({
  line,
  index,
  wrap,
  hangingIndent,
  showLineNumbers,
  proseStrings,
  repeatCommentMarker,
  tokenStyles,
  renderToken,
}: {
  line: CodeLine;
  index: number;
} & Required<
  Pick<
    RenderedCodeProps,
    | "wrap"
    | "hangingIndent"
    | "showLineNumbers"
    | "proseStrings"
    | "repeatCommentMarker"
  >
> &
  Pick<RenderedCodeProps, "tokenStyles" | "renderToken">) {
  const contentStyle = lineStyle(line.layout.wrapIndent, hangingIndent, wrap);
  const tokens = (
    <Tokens
      tokens={line.tokens}
      proseStrings={proseStrings}
      tokenStyles={tokenStyles}
      renderToken={renderToken}
    />
  );
  const comment = line.layout.comment;
  const useMarkers = wrap && repeatCommentMarker && !!comment;

  return (
    <span className="codebox__line">
      {showLineNumbers && (
        <span className="codebox__ln" aria-hidden="true" data-line={index + 1}>
          {index + 1}
        </span>
      )}
      {useMarkers && comment ? (
        <CommentContent
          contentStyle={contentStyle}
          marker={comment.marker}
          markerColor={line.tokens.find((t) => t.kind === "comment")?.color}
          wrapIndentChars={line.layout.wrapIndentChars}
          hangingIndent={hangingIndent}
          wrap={wrap}
        >
          {tokens}
        </CommentContent>
      ) : (
        <PlainContent
          contentStyle={contentStyle}
          wrapIndentChars={line.layout.wrapIndentChars}
          hangingIndent={hangingIndent}
          wrap={wrap}
        >
          {tokens}
        </PlainContent>
      )}
    </span>
  );
}

/**
 * Render already-highlighted code. The async work is done; this is the layout
 * layer: structural indent-aware wrapping, prose string bodies, customizable
 * comment/string styling, and repeated comment markers.
 */
export function RenderedCode({
  data,
  wrap = true,
  hangingIndent = 0,
  showLineNumbers = false,
  proseStrings = true,
  repeatCommentMarker = true,
  tokenStyles,
  renderToken,
  className,
  style,
}: RenderedCodeProps) {
  const preRef = useRef<HTMLPreElement>(null);
  // Size the prose font to match the code font's x-height (skipped when prose
  // strings are off, or when the user overrides --codebox-prose-font-size).
  const proseFontSize = useProseFontSizeVar(preRef, proseStrings);
  const proseVar = proseFontSize
    ? ({ ["--codebox-prose-font-size-measured"]: proseFontSize } as CSSProperties)
    : undefined;
  return (
    <pre
      ref={preRef}
      className={classNames(
        "codebox",
        wrap ? "codebox--wrap" : "codebox--scroll",
        showLineNumbers && "codebox--numbered",
        className,
      )}
      style={{ color: data.fg, background: data.bg, ...proseVar, ...style }}
      data-codebox-lang={data.lang}
    >
      <code className="codebox__code">
        {data.lines.map((line, i) => (
          <Line
            key={i}
            line={line}
            index={i}
            wrap={wrap}
            hangingIndent={hangingIndent}
            showLineNumbers={showLineNumbers}
            proseStrings={proseStrings}
            repeatCommentMarker={repeatCommentMarker}
            tokenStyles={tokenStyles}
            renderToken={renderToken}
          />
        ))}
      </code>
    </pre>
  );
}

/**
 * Convenience component: highlights `code` asynchronously, then renders it.
 * While the highlighter loads (or if it errors), the raw code is shown as plain
 * text so something readable is always on screen.
 */
export function CodeBox({
  code,
  lang,
  theme,
  tabSize,
  continuationIndent,
  fallback,
  ...renderProps
}: CodeBoxProps) {
  const [data, setData] = useState<HighlightedCode | null>(null);

  useEffect(() => {
    let active = true;
    highlightToLines(code, { lang, theme, tabSize, continuationIndent })
      .then((d) => {
        if (active) setData(d);
      })
      .catch(() => {
        if (active) setData(null);
      });
    return () => {
      active = false;
    };
  }, [code, lang, theme, tabSize, continuationIndent]);

  if (!data) {
    return (
      fallback ?? (
        <pre className="codebox codebox--plain">
          <code className="codebox__code">{code}</code>
        </pre>
      )
    );
  }

  return <RenderedCode data={data} {...renderProps} />;
}
