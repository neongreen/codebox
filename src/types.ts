import type { CSSProperties, ReactNode } from "react";
import type { LineLayout, TokenKind } from "./classify";

/** Languages codebox ships with grammars for out of the box. */
export const SUPPORTED_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "css",
  "json",
  "yaml",
] as const;

export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

/** Language aliases accepted by the API and normalized to a SupportedLang. */
export const LANG_ALIASES: Record<string, SupportedLang> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  tsx: "tsx",
  jsx: "jsx",
  css: "css",
  json: "json",
  json5: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
};

/** A single highlighted token (a run of characters with one color). */
export interface CodeToken {
  content: string;
  color?: string;
  bgColor?: string;
  /** Shiki font-style bitmask: 1=italic, 2=bold, 4=underline. */
  fontStyle?: number;
  /** Coarse classification from TextMate scopes: code / string / comment. */
  kind: TokenKind;
}

/** One source line, decomposed into tokens plus its measured layout. */
export interface CodeLine {
  /** The raw text of the line (no trailing newline). */
  text: string;
  /** Leading-indent width in columns (tabs expanded to tabSize). */
  indent: number;
  /** Structural wrap/alignment info for this line. */
  layout: LineLayout;
  tokens: CodeToken[];
}

/** Fully highlighted code, ready to render synchronously (SSR-friendly). */
export interface HighlightedCode {
  lines: CodeLine[];
  /** Foreground color from the theme. */
  fg: string;
  /** Background color from the theme. */
  bg: string;
  lang: SupportedLang;
  theme: string;
  tabSize: number;
}

export interface HighlightOptions {
  lang: string;
  /** Any Shiki theme name. Defaults to "github-light". */
  theme?: string;
  /** Columns a tab expands to when measuring indentation. Defaults to 2. */
  tabSize?: number;
  /**
   * Columns a wrapped continuation falls in by when structural alignment would
   * otherwise put it at (or left of) the line's first character. Enforces the
   * rule that continuations are always indented strictly more. Defaults to
   * `tabSize`.
   */
  continuationIndent?: number;
}

/** Per-kind style overrides. Merged on top of the theme colors. */
export interface TokenStyles {
  comment?: CSSProperties;
  string?: CSSProperties;
  code?: CSSProperties;
}

export interface RenderedCodeProps {
  data: HighlightedCode;
  /**
   * Soft-wrap long lines instead of scrolling horizontally. Default true.
   * When wrapping, continuation lines are indented to line up under the
   * code (Xcode-style indent-aware wrapping) rather than resetting to col 0.
   * Alignment follows structure: function args align under the first arg,
   * string bodies under the opening quote, comments under the comment text.
   */
  wrap?: boolean;
  /** Extra columns added to wrapped continuation lines. Default 0. */
  hangingIndent?: number;
  showLineNumbers?: boolean;
  /**
   * Render the *contents* of string literals in a proportional ("prose") font
   * so long strings read like aligned text blocks. Code stays monospace.
   * Default true.
   */
  proseStrings?: boolean;
  /**
   * When a line comment wraps, repeat its marker (//, #, …) at the start of
   * each continuation line. Client-side enhancement (needs layout). Default
   * true.
   */
  repeatCommentMarker?: boolean;
  /** Inline style overrides per token kind (comment/string/code). */
  tokenStyles?: TokenStyles;
  /** Escape hatch: fully control how a token renders. */
  renderToken?: (token: CodeToken, index: number) => ReactNode;
  className?: string;
  style?: CSSProperties;
}

export interface CodeBoxProps
  extends Omit<RenderedCodeProps, "data"> {
  code: string;
  lang: string;
  theme?: string;
  tabSize?: number;
  /** See {@link HighlightOptions.continuationIndent}. Defaults to `tabSize`. */
  continuationIndent?: number;
  /** Rendered while the async highlighter loads. Defaults to plain code. */
  fallback?: ReactNode;
}
