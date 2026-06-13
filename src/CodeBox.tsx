import {
  createElement,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { highlightToLines } from "./highlight";
import { lineStyle } from "./indent";
import type {
  CodeBoxProps,
  CodeToken,
  HighlightedCode,
  RenderedCodeProps,
} from "./types";

function tokenStyle(token: CodeToken): CSSProperties {
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.bgColor) style.backgroundColor = token.bgColor;
  const fs = token.fontStyle;
  if (fs && fs > 0) {
    if (fs & 1) style.fontStyle = "italic";
    if (fs & 2) style.fontWeight = "bold";
    if (fs & 4) style.textDecoration = "underline";
  }
  return style;
}

function classNames(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Render already-highlighted code. Pure and synchronous, so it works in SSR and
 * is trivially testable. This is where the indent-aware wrapping happens.
 */
export function RenderedCode({
  data,
  wrap = true,
  hangingIndent = 0,
  showLineNumbers = false,
  className,
  style,
}: RenderedCodeProps) {
  const rootStyle: CSSProperties = {
    color: data.fg,
    background: data.bg,
    ...style,
  };

  return createElement(
    "pre",
    {
      className: classNames(
        "codebox",
        wrap ? "codebox--wrap" : "codebox--scroll",
        showLineNumbers && "codebox--numbered",
        className,
      ),
      style: rootStyle,
      "data-codebox-lang": data.lang,
    },
    createElement(
      "code",
      { className: "codebox__code" },
      data.lines.map((line, i) =>
        createElement(
          "span",
          { className: "codebox__line", key: i },
          showLineNumbers &&
            createElement(
              "span",
              {
                className: "codebox__ln",
                "aria-hidden": "true",
                "data-line": i + 1,
              },
              String(i + 1),
            ),
          createElement(
            "span",
            {
              className: "codebox__content",
              style: lineStyle(line.indent, hangingIndent, wrap),
            },
            line.tokens.length === 0
              ? "\n"
              : line.tokens.map((token, j) =>
                  createElement(
                    "span",
                    { key: j, style: tokenStyle(token) },
                    token.content,
                  ),
                ),
          ),
        ),
      ),
    ),
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
  fallback,
  ...renderProps
}: CodeBoxProps) {
  const [data, setData] = useState<HighlightedCode | null>(null);

  useEffect(() => {
    let active = true;
    highlightToLines(code, { lang, theme, tabSize })
      .then((d) => {
        if (active) setData(d);
      })
      .catch(() => {
        if (active) setData(null);
      });
    return () => {
      active = false;
    };
  }, [code, lang, theme, tabSize]);

  if (!data) {
    return (
      fallback ??
      createElement(
        "pre",
        { className: "codebox codebox--plain" },
        createElement("code", { className: "codebox__code" }, code),
      )
    );
  }

  return createElement(RenderedCode, { data, ...renderProps });
}
