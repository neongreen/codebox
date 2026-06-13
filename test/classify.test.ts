import { describe, expect, test } from "bun:test";
import { classifyScopes, computeLineLayout } from "../src/classify";
import { highlightToLines } from "../src/highlight";
import { leadingIndentWidth } from "../src/indent";

describe("classifyScopes", () => {
  test("comment scopes win", () => {
    expect(classifyScopes(["source.ts", "comment.line.double-slash.ts"])).toBe(
      "comment",
    );
  });
  test("string scopes", () => {
    expect(classifyScopes(["source.ts", "string.quoted.double.ts"])).toBe(
      "string",
    );
  });
  test("regexp stays code", () => {
    expect(classifyScopes(["source.ts", "string.regexp.ts"])).toBe("code");
  });
  test("plain code", () => {
    expect(classifyScopes(["source.ts", "keyword.operator.ts"])).toBe("code");
  });
});

// Helper to build kinded tokens for a line with explicit kinds.
type T = { content: string; kind: "code" | "string" | "comment" };
function layout(tokens: T[], tabSize = 2) {
  const text = tokens.map((t) => t.content).join("");
  return computeLineLayout(tokens, leadingIndentWidth(text, tabSize), tabSize);
}

describe("computeLineLayout: wrap alignment", () => {
  test("plain expression: continuation falls in past the leading indent", () => {
    // leading indent 4, no structure -> 4 + continuationIndent(2) = 6,
    // strictly greater than the first character's column.
    expect(layout([{ content: "    return value", kind: "code" }]).wrapIndent).toBe(
      6,
    );
  });

  test("aligns under the first argument of an open call", () => {
    // "foo(a, b, c" — '(' at col 3, args start at col 4
    const l = layout([
      { content: "foo", kind: "code" },
      { content: "(a, b, c", kind: "code" },
    ]);
    expect(l.wrapIndent).toBe(4);
  });

  test("uses the first/outermost bracket", () => {
    // "f(g(a, b" — first '(' at col 1 -> align col 2
    const l = layout([{ content: "f(g(a, b", kind: "code" }]);
    expect(l.wrapIndent).toBe(2);
  });

  test("ignores brackets inside strings", () => {
    // 'foo("(", a' — the '(' inside the string must not count; real '(' at col 3
    const l = layout([
      { content: "foo", kind: "code" },
      { content: "(", kind: "code" },
      { content: '"("', kind: "string" },
      { content: ", a", kind: "code" },
    ]);
    expect(l.wrapIndent).toBe(4);
  });

  test("aligns under args even when the call is balanced (it can still wrap)", () => {
    // "  foo(a, b)" — '(' at col 5, args at col 6
    const l = layout([{ content: "  foo(a, b)", kind: "code" }]);
    expect(l.wrapIndent).toBe(6);
  });

  test("no brackets -> leading indent plus one level (strictly more)", () => {
    const l = layout([{ content: "    a + b + c", kind: "code" }]);
    expect(l.wrapIndent).toBe(6);
  });

  test("continuation is always strictly greater than the first char column", () => {
    const cases: { content: string; kind: "code" | "string" | "comment" }[][] = [
      [{ content: "x = y", kind: "code" }],
      [{ content: "      deeplyIndented", kind: "code" }],
      // a bare template-literal middle line (pure string body, no quote)
      [{ content: "  more string text here", kind: "string" }],
    ];
    for (const toks of cases) {
      const text = toks.map((t) => t.content).join("");
      const lead = leadingIndentWidth(text, 2);
      expect(layout(toks).wrapIndent).toBeGreaterThan(lead);
    }
  });

  test("aligns string body under the opening quote", () => {
    // 'const x = "abc' — string starts at col 10, content at col 11
    const l = layout([
      { content: "const x = ", kind: "code" },
      { content: '"abc', kind: "string" },
    ]);
    expect(l.stringContentCol).toBe(11);
    expect(l.wrapIndent).toBe(11);
  });

  test("full-line comment: marker, text column, and wrap alignment", () => {
    // "  // hello" — marker '//' at col 2, text at col 5
    const l = layout([
      { content: "  ", kind: "code" },
      { content: "// hello", kind: "comment" },
    ]);
    expect(l.comment).toEqual({ marker: "//", markerCol: 2, textCol: 5 });
    expect(l.wrapIndent).toBe(5);
  });

  test("hash comment marker", () => {
    const l = layout([{ content: "# a note", kind: "comment" }]);
    expect(l.comment?.marker).toBe("#");
    expect(l.wrapIndent).toBe(2);
  });

  test("trailing comment aligns continuations under the comment text", () => {
    const l = layout([
      { content: "x = 1; ", kind: "code" },
      { content: "// why", kind: "comment" },
    ]);
    expect(l.comment?.markerCol).toBe(7);
    expect(l.wrapIndent).toBe(10); // 7 + len('//') + 1 space
  });
});

describe("computeLineLayout via real highlighting", () => {
  test("a real function-call line aligns under its arguments", async () => {
    const code = `const r = compute(alpha, beta, gamma);`;
    const data = await highlightToLines(code, { lang: "typescript" });
    const open = code.indexOf("(");
    expect(data.lines[0]!.layout.wrapIndent).toBe(open + 1);
  });

  test("a real comment line is detected with its marker", async () => {
    const code = `  // an explanatory comment`;
    const data = await highlightToLines(code, { lang: "typescript" });
    expect(data.lines[0]!.layout.comment?.marker).toBe("//");
  });

  test("string tokens are classified as string", async () => {
    const code = `const s = "hello world";`;
    const data = await highlightToLines(code, { lang: "typescript" });
    const kinds = new Set(data.lines[0]!.tokens.map((t) => t.kind));
    expect(kinds.has("string")).toBe(true);
    expect(kinds.has("code")).toBe(true);
  });
});
