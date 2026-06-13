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

  test("wrap on: indented line gets matching hanging-indent style", async () => {
    // line 2 is indented 2 cols -> expect padding-left:2ch + text-indent:-2ch
    const html = await markup("function f() {\n  return 1;\n}", { wrap: true });
    expect(html).toContain("padding-left:2ch");
    expect(html).toContain("text-indent:-2ch");
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
});
