import { describe, expect, test } from "bun:test";
import { highlightToLines, normalizeLang } from "../src/highlight";
import { SUPPORTED_LANGS } from "../src/types";

const SAMPLES: Record<string, string> = {
  typescript: `const greeting: string = "hello";\nfunction add(a: number, b: number) {\n  return a + b;\n}`,
  javascript: `const x = 1;\nfunction f() {\n  return x + 2;\n}`,
  tsx: `const App = () => {\n  return <div className="box">hi</div>;\n};`,
  jsx: `function App() {\n  return <span>hi</span>;\n}`,
  css: `.box {\n  color: red;\n  padding: 4px;\n}`,
  json: `{\n  "name": "codebox",\n  "version": 1\n}`,
  yaml: `name: codebox\nlist:\n  - one\n  - two`,
};

describe("normalizeLang", () => {
  test("resolves aliases", () => {
    expect(normalizeLang("ts")).toBe("typescript");
    expect(normalizeLang("JS")).toBe("javascript");
    expect(normalizeLang(" yml ")).toBe("yaml");
    expect(normalizeLang("jsonc")).toBe("json");
  });

  test("throws on unsupported language", () => {
    expect(() => normalizeLang("brainfuck")).toThrow(/unsupported language/);
  });
});

describe("highlightToLines: every supported language", () => {
  for (const lang of SUPPORTED_LANGS) {
    test(`${lang}: produces lines, tokens and theme colors`, async () => {
      const code = SAMPLES[lang]!;
      const result = await highlightToLines(code, { lang });

      // One CodeLine per source line.
      expect(result.lines.length).toBe(code.split("\n").length);

      // Tokens reconstruct the original text exactly.
      const rebuilt = result.lines.map((l) => l.text).join("\n");
      expect(rebuilt).toBe(code);

      // Theme colors are present.
      expect(result.fg).toBeTruthy();
      expect(result.bg).toBeTruthy();

      // At least one token carries a real (non-foreground) color -> highlighting
      // actually happened, it isn't all one flat color.
      const colors = new Set(
        result.lines.flatMap((l) => l.tokens.map((t) => t.color)),
      );
      expect(colors.size).toBeGreaterThan(1);
    });
  }
});

describe("highlightToLines: indentation is measured per line", () => {
  test("nested code reports increasing indents", async () => {
    const code = `function f() {\n  if (true) {\n    return 1;\n  }\n}`;
    const result = await highlightToLines(code, { lang: "typescript" });
    expect(result.lines.map((l) => l.indent)).toEqual([0, 2, 4, 2, 0]);
  });

  test("respects tabSize", async () => {
    const code = "\tindented";
    const r2 = await highlightToLines(code, { lang: "typescript", tabSize: 2 });
    const r4 = await highlightToLines(code, { lang: "typescript", tabSize: 4 });
    expect(r2.lines[0]!.indent).toBe(2);
    expect(r4.lines[0]!.indent).toBe(4);
  });
});

describe("highlightToLines: themes", () => {
  test("loads a second theme on demand", async () => {
    const light = await highlightToLines("const x = 1", {
      lang: "typescript",
      theme: "github-light",
    });
    const dark = await highlightToLines("const x = 1", {
      lang: "typescript",
      theme: "github-dark",
    });
    expect(light.bg).not.toBe(dark.bg);
  });
});
