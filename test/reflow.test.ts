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
  test("a non-chain line is left untouched", async () => {
    const t = await toks("const x = foo(a, b, c) + bar;");
    const r = reflowLine(t, 10);
    expect(r.reflowed).toBe(false);
    expect(r.lines).toHaveLength(1);
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
