import { describe, expect, test } from "bun:test";
import { highlightToLines } from "../src/highlight";
import { reflowLine, reflowToString } from "../src/reflow";
import type { CodeToken } from "../src/types";

/** Build code-kind tokens from a raw string (one token per call is fine; the
 *  reflow works at the character level and re-coalesces). */
async function toks(code: string): Promise<CodeToken[]> {
  const data = await highlightToLines(code, { lang: "typescript" });
  return data.lines[0]!.tokens;
}

describe("reflowLine: chain reformatting", () => {
  test("a line with nothing breakable is left untouched", async () => {
    const t = await toks("const ok = a && b && c && d && e && f && g && h;");
    const r = reflowLine(t, 10);
    expect(r.reflowed).toBe(false);
    expect(r.lines).toHaveLength(1);
  });

  test("a standalone call breaks its args one per line (no mid-identifier wrap)", async () => {
    const t = await toks("const r = compute(alpha, beta, gamma, delta);");
    expect(reflowToString(t, 20)).toBe(
      [
        "const r = compute(",
        "  alpha,",
        "  beta,",
        "  gamma,",
        "  delta",
        ");",
      ].join("\n"),
    );
  });

  test("an array literal breaks one element per line when it overflows", async () => {
    const t = await toks("const xs = [one, two, three, four, five];");
    expect(reflowToString(t, 14)).toBe(
      ["const xs = [", "  one,", "  two,", "  three,", "  four,", "  five", "];"].join(
        "\n",
      ),
    );
  });

  test("property accesses split by an operator are NOT a chain", async () => {
    // Two `.` accesses on different receivers, separated by `&&`/`>` — must not
    // be reformatted as one chain (regression: this used to break before
    // `.length` and `.active`).
    const t = await toks(
      "const ok = a.length > 0 && b.active && c.ready && d.enabled;",
    );
    expect(reflowLine(t, 10).reflowed).toBe(false);
  });

  test("an assignment prefix stays on the first line; only the chain breaks", async () => {
    const t = await toks("this.result = source.filter(ok).map(id).slice(0);");
    expect(reflowToString(t, 24)).toBe(
      [
        "this.result = source",
        "  .filter(ok)",
        "  .map(id)",
        "  .slice(0);",
      ].join("\n"),
    );
  });

  test("a chain that fits stays on one line", async () => {
    const t = await toks("items.filter(ok).map(id).slice(0, 10)");
    expect(reflowToString(t, 200)).toBe("items.filter(ok).map(id).slice(0, 10)");
  });

  test("a chain that overflows breaks one call per line under the head", async () => {
    const t = await toks("items.filter(ok).map(id).slice(0, 10)");
    // Width forces the chain to break, but each call still fits on its line.
    expect(reflowToString(t, 20)).toBe(
      ["items", "  .filter(ok)", "  .map(id)", "  .slice(0, 10)"].join("\n"),
    );
  });

  test("leading indentation is preserved and links indent past it", async () => {
    const t = await toks("    items.filter(ok).map(id).slice(0, 10)");
    expect(reflowToString(t, 20)).toBe(
      [
        "    items",
        "      .filter(ok)",
        "      .map(id)",
        "      .slice(0, 10)",
      ].join("\n"),
    );
  });

  test("nested: only the call that is still too wide breaks its arguments", async () => {
    const t = await toks(
      "data.filter(alpha, beta, gamma, delta).map(id).slice(0)",
    );
    // The chain breaks; .filter(...) is wider than the others, so only it
    // descends and breaks its argument list — .map / .slice stay intact.
    const s = reflowToString(t, 24);
    expect(s).toBe(
      [
        "data",
        "  .filter(",
        "    alpha,",
        "    beta,",
        "    gamma,",
        "    delta",
        "  )",
        "  .map(id)",
        "  .slice(0)",
      ].join("\n"),
    );
  });

  test("a small group doesn't break just because later content overflows", async () => {
    // Regression: `(r)` must stay on one line even though the arrow body that
    // follows it overflows (Wadler `fits` coupling bug).
    const t = await toks("rows.map((r) => ({ id: r.id, name: r.name, ok: r.ok }))");
    const lines = reflowToString(t, 22).split("\n");
    // `(r)` is intact on some line; no line is a lone `(` or `r`.
    expect(lines.some((l) => l.includes("(r)"))).toBe(true);
    expect(lines.some((l) => l.trim() === "r")).toBe(false);
  });

  test("never alters non-space characters (only relocates whitespace)", async () => {
    const code = "obj.aaaa(1, 2).bbbb(3, 4).cccc(5, 6)";
    const t = await toks(code);
    for (const width of [5, 12, 20, 80, 500]) {
      const flattened = reflowToString(t, width).replace(/\s+/g, "");
      expect(flattened).toBe(code.replace(/\s+/g, ""));
    }
  });

  test("custom indent unit", async () => {
    const t = await toks("a.bbb().ccc().ddd()");
    expect(reflowToString(t, 8, 4)).toBe(
      ["a", "    .bbb()", "    .ccc()", "    .ddd()"].join("\n"),
    );
  });
});
