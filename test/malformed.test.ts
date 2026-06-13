import { describe, expect, test } from "bun:test";
import { highlightToLines } from "../src/highlight";

/**
 * The headline robustness property: codebox must render even when the input is
 * not valid code. Shiki's TextMate tokenizer is a lexer, not a parser, so it
 * never throws on broken syntax — these tests lock that guarantee in.
 */
const BROKEN: Array<{ name: string; lang: string; code: string }> = [
  {
    name: "unterminated string (ts)",
    lang: "typescript",
    code: `const s = "open string\nconst n = 1;`,
  },
  {
    name: "unbalanced braces (ts)",
    lang: "typescript",
    code: `function f( {\n  return {{{ ;\n`,
  },
  {
    name: "half-typed expression (js)",
    lang: "javascript",
    code: `const x = arr.map(=>\nlet`,
  },
  {
    name: "truncated tsx tag",
    lang: "tsx",
    code: `const a = <div className=\n  <span`,
  },
  {
    name: "broken json (trailing comma + missing quote)",
    lang: "json",
    code: `{\n  name: "x",\n  "v": ,\n`,
  },
  {
    name: "broken css (missing brace + bad value)",
    lang: "css",
    code: `.a { color: ; \n.b { width`,
  },
  {
    name: "broken yaml (bad indent + dangling colon)",
    lang: "yaml",
    code: `a:\n  - x\n bad:\n:`,
  },
  {
    name: "garbage / mojibake",
    lang: "typescript",
    code: `@@@ ))) <<< \u{1f4a9}\n\t???`,
  },
  { name: "empty input", lang: "typescript", code: `` },
  { name: "only whitespace", lang: "css", code: `   \n\t\n  ` },
];

describe("malformed input never throws and still tokenizes", () => {
  for (const c of BROKEN) {
    test(c.name, async () => {
      const result = await highlightToLines(c.code, { lang: c.lang });

      // Did not throw; returned a structured result.
      expect(Array.isArray(result.lines)).toBe(true);

      // Line count still matches the input, and text round-trips exactly even
      // though the code is invalid.
      const expectedLines = c.code === "" ? 1 : c.code.split("\n").length;
      expect(result.lines.length).toBe(expectedLines);
      expect(result.lines.map((l) => l.text).join("\n")).toBe(c.code);
    });
  }
});
