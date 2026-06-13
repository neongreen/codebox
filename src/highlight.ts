import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { leadingIndentWidth } from "./indent";
import {
  LANG_ALIASES,
  SUPPORTED_LANGS,
  type CodeLine,
  type HighlightedCode,
  type HighlightOptions,
  type SupportedLang,
} from "./types";

// Fine-grained Shiki: we bundle exactly the grammars and themes codebox
// supports, so consumers (and the demo) only ship those — not Shiki's full
// hundreds-of-languages registry. The JavaScript regex engine avoids loading
// the Oniguruma wasm blob entirely.
import tsLang from "@shikijs/langs/typescript";
import jsLang from "@shikijs/langs/javascript";
import tsxLang from "@shikijs/langs/tsx";
import jsxLang from "@shikijs/langs/jsx";
import cssLang from "@shikijs/langs/css";
import jsonLang from "@shikijs/langs/json";
import yamlLang from "@shikijs/langs/yaml";
import githubLight from "@shikijs/themes/github-light";
import githubDark from "@shikijs/themes/github-dark";

const BUNDLED_LANGS = {
  typescript: tsLang,
  javascript: jsLang,
  tsx: tsxLang,
  jsx: jsxLang,
  css: cssLang,
  json: jsonLang,
  yaml: yamlLang,
} satisfies Record<SupportedLang, unknown>;

/** Themes codebox ships with. Pass any of these names to the `theme` prop. */
export const BUNDLED_THEMES = ["github-light", "github-dark"] as const;
export type BundledTheme = (typeof BUNDLED_THEMES)[number];

const THEME_OBJECTS = {
  "github-light": githubLight,
  "github-dark": githubDark,
};

const DEFAULT_THEME: BundledTheme = "github-light";

let corePromise: Promise<HighlighterCore> | null = null;

/**
 * Lazily create the shared (singleton) Shiki core highlighter with all bundled
 * grammars and themes registered up front.
 */
export function getHighlighter(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = createHighlighterCore({
      themes: Object.values(THEME_OBJECTS),
      langs: Object.values(BUNDLED_LANGS),
      // forgiving: don't throw on grammar patterns the JS engine can't model,
      // which also keeps malformed input from blowing up.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return corePromise;
}

/** Normalize a user-supplied language string to a supported grammar. */
export function normalizeLang(lang: string): SupportedLang {
  const key = lang.toLowerCase().trim();
  const resolved = LANG_ALIASES[key];
  if (!resolved) {
    throw new Error(
      `codebox: unsupported language "${lang}". Supported: ${SUPPORTED_LANGS.join(
        ", ",
      )} (and aliases ${Object.keys(LANG_ALIASES).join(", ")}).`,
    );
  }
  return resolved;
}

function normalizeTheme(theme: string | undefined): BundledTheme {
  const name = (theme ?? DEFAULT_THEME) as BundledTheme;
  if (!BUNDLED_THEMES.includes(name)) {
    throw new Error(
      `codebox: unsupported theme "${theme}". Bundled themes: ${BUNDLED_THEMES.join(
        ", ",
      )}.`,
    );
  }
  return name;
}

/**
 * Highlight source into a structured, render-ready shape.
 *
 * Uses Shiki's TextMate tokenizer, which tolerates malformed input: it never
 * throws on broken syntax, it just stops applying scopes past the breakage.
 * That gives us robust highlighting of incomplete/invalid code for free.
 */
export async function highlightToLines(
  code: string,
  options: HighlightOptions,
): Promise<HighlightedCode> {
  const lang = normalizeLang(options.lang);
  const theme = normalizeTheme(options.theme);
  const tabSize = options.tabSize ?? 2;

  const hl = await getHighlighter();
  const result = hl.codeToTokens(code, { lang, theme });

  const lines: CodeLine[] = result.tokens.map((lineTokens) => {
    const text = lineTokens.map((t) => t.content).join("");
    return {
      text,
      indent: leadingIndentWidth(text, tabSize),
      tokens: lineTokens.map((t) => ({
        content: t.content,
        color: t.color,
        bgColor: t.bgColor,
        fontStyle: t.fontStyle,
      })),
    };
  });

  return {
    lines,
    fg: result.fg ?? "inherit",
    bg: result.bg ?? "transparent",
    lang,
    theme,
    tabSize,
  };
}
