import type { CSSProperties, ReactNode } from "react";

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
}

/** One source line, decomposed into tokens plus its measured indentation. */
export interface CodeLine {
  /** The raw text of the line (no trailing newline). */
  text: string;
  /** Leading-indent width in columns (tabs expanded to tabSize). */
  indent: number;
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
}

export interface RenderedCodeProps {
  data: HighlightedCode;
  /**
   * Soft-wrap long lines instead of scrolling horizontally. Default true.
   * When wrapping, continuation lines are indented to line up under the
   * code (Xcode-style indent-aware wrapping) rather than resetting to col 0.
   */
  wrap?: boolean;
  /** Extra columns added to wrapped continuation lines. Default 0. */
  hangingIndent?: number;
  showLineNumbers?: boolean;
  className?: string;
  style?: CSSProperties;
}

export interface CodeBoxProps
  extends Omit<RenderedCodeProps, "data"> {
  code: string;
  lang: string;
  theme?: string;
  tabSize?: number;
  /** Rendered while the async highlighter loads. Defaults to plain code. */
  fallback?: ReactNode;
}
