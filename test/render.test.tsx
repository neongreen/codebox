import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderedCode } from "../src/CodeBox";
import { highlightToLines } from "../src/highlight";

async function markup(code: string, props: Record<string, unknown> = {}) {
  const data = await highlightToLines(code, {
    lang: (props.lang as string) ?? "typescript",
  });
  return renderToStaticMarkup(<RenderedCode data={data} {...props} />);
}

describe("RenderedCode markup", () => {
  test("renders one line element per source line", async () => {
    const html = await markup("a\nb\nc");
    const lineCount = (html.match(/class="codebox__line"/g) ?? []).length;
    expect(lineCount).toBe(3);
  });

  test("emits per-token color spans (highlighting reaches the DOM)", async () => {
    const html = await markup(`const x = "hi";`);
    expect(html).toContain("color:");
  });

  test("wrap on: indented line continuation falls in past the indent", async () => {
    // line 2 "  return 1;" is indented 2 cols, no structure -> continuation at
    // 2 + continuationIndent(2) = 4 (strictly more than the first character).
    const html = await markup("function f() {\n  return 1;\n}", { wrap: true });
    expect(html).toContain("padding-left:min(4ch");
    expect(html).toContain("text-indent:calc(-1 * min(4ch");
    expect(html).toContain("white-space:pre-wrap");
  });

  test("wrap off: no hanging indent, uses pre", async () => {
    const html = await markup("function f() {\n  return 1;\n}", { wrap: false });
    expect(html).not.toContain("padding-left:");
    expect(html).not.toContain("text-indent:");
    expect(html).toContain("white-space:pre");
  });

  test("line numbers render in a gutter when requested", async () => {
    const html = await markup("a\nb", { showLineNumbers: true });
    expect(html).toContain("codebox__ln");
    expect(html).toContain("codebox--numbered");
  });

  test("applies theme foreground/background to the root", async () => {
    const data = await highlightToLines("const x = 1", {
      lang: "typescript",
      theme: "github-light",
    });
    const html = renderToStaticMarkup(<RenderedCode data={data} />);
    expect(html).toContain(`background:${data.bg}`);
  });

  test("exposes language as a data attribute", async () => {
    const html = await markup("const x = 1", { lang: "ts" });
    expect(html).toContain('data-codebox-lang="typescript"');
  });

  test("string tokens get prose class by default; opt out with proseStrings", async () => {
    const on = await markup(`const s = "hi";`);
    expect(on).toContain("codebox__tok--string");
    expect(on).toContain("codebox__tok--prose");
    const off = await markup(`const s = "hi";`, { proseStrings: false });
    expect(off).toContain("codebox__tok--string");
    expect(off).not.toContain("codebox__tok--prose");
  });

  test("comment tokens get a comment class", async () => {
    const html = await markup("// hello\nconst x = 1");
    expect(html).toContain("codebox__tok--comment");
  });

  test("tokenStyles overrides per kind", async () => {
    const html = await markup("// hi\nx", {
      tokenStyles: { comment: { fontStyle: "italic", opacity: 0.5 } },
    });
    expect(html).toContain("opacity:0.5");
  });

  test("renderToken escape hatch fully controls token output", async () => {
    const html = await markup("const x = 1", {
      renderToken: (t: { content: string }) => t.content.toUpperCase(),
    });
    expect(html).toContain("CONST");
    expect(html).not.toContain("codebox__tok");
  });

  test("aligns wrapped continuations under function args (style reflects col)", async () => {
    // 'const r = f(a, b);' -> '(' at index 11, args at col 12
    const html = await markup("const r = f(a, b);", { wrap: true });
    expect(html).toContain("padding-left:min(12ch");
  });
});
