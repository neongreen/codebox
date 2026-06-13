import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
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
  children,
}: {
  contentStyle: CSSProperties;
  marker: string;
  markerColor?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tops, setTops] = useState<number[]>([]);
  const [left, setLeft] = useState(0);

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
      style={{ position: "relative", ...contentStyle }}
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
        >
          {tokens}
        </CommentContent>
      ) : (
        <span className="codebox__content" style={contentStyle}>
          {tokens}
        </span>
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
  return (
    <pre
      className={classNames(
        "codebox",
        wrap ? "codebox--wrap" : "codebox--scroll",
        showLineNumbers && "codebox--numbered",
        className,
      )}
      style={{ color: data.fg, background: data.bg, ...style }}
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
