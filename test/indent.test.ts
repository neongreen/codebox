import { describe, expect, test } from "bun:test";
import { leadingIndentWidth, lineStyle } from "../src/indent";

describe("leadingIndentWidth", () => {
  test("no indent", () => {
    expect(leadingIndentWidth("const x = 1")).toBe(0);
  });

  test("counts leading spaces", () => {
    expect(leadingIndentWidth("    return x")).toBe(4);
    expect(leadingIndentWidth("  a")).toBe(2);
  });

  test("expands tabs to the tab stop", () => {
    expect(leadingIndentWidth("\tx", 2)).toBe(2);
    expect(leadingIndentWidth("\t\tx", 2)).toBe(4);
    expect(leadingIndentWidth("\tx", 4)).toBe(4);
  });

  test("mixed tabs and spaces advance to the next tab stop", () => {
    // one space (col 1) then a tab -> advances to col 2 (tabSize 2)
    expect(leadingIndentWidth(" \tx", 2)).toBe(2);
    // two spaces (col 2) then a tab -> advances to col 4
    expect(leadingIndentWidth("  \tx", 2)).toBe(4);
  });

  test("stops at first non-whitespace", () => {
    expect(leadingIndentWidth("  a  b")).toBe(2);
  });

  test("blank line has zero indent", () => {
    expect(leadingIndentWidth("")).toBe(0);
    expect(leadingIndentWidth("    ")).toBe(4); // all-whitespace line
  });
});

describe("lineStyle (indent-aware wrapping)", () => {
  test("wrap on: hanging indent equals the line indent (capped)", () => {
    const s = lineStyle(4, 0, true);
    expect(s.whiteSpace).toBe("pre-wrap");
    // The ch value is the *fallback*; the renderer overrides --codebox-wrap-indent
    // with a measured pixel offset once mounted.
    expect(s.paddingLeft).toBe(
      "min(var(--codebox-wrap-indent, 4ch), var(--codebox-max-wrap, 66cqw))",
    );
    expect(s.textIndent).toBe(
      "calc(-1 * min(var(--codebox-wrap-indent, 4ch), var(--codebox-max-wrap, 66cqw)))",
    );
  });

  test("wrap on: extra hanging indent is added on top of the indent", () => {
    const s = lineStyle(4, 2, true);
    expect(s.paddingLeft).toContain("6ch");
  });

  test("padding and text-indent reference the same capped value so line 1 stays flush", () => {
    // The core invariant: first visual line begins at column 0 because
    // text-indent negates padding-left exactly (whichever min() branch wins).
    for (const [indent, hang] of [
      [0, 0],
      [2, 0],
      [8, 4],
    ] as const) {
      const s = lineStyle(indent, hang, true);
      const total = indent + hang;
      const capped = `min(var(--codebox-wrap-indent, ${total}ch), var(--codebox-max-wrap, 66cqw))`;
      expect(s.paddingLeft).toBe(capped);
      expect(s.textIndent).toBe(`calc(-1 * ${capped})`);
    }
  });

  test("wrap off: no hanging indent, uses pre (scroll mode)", () => {
    const s = lineStyle(4, 0, false);
    expect(s.whiteSpace).toBe("pre");
    expect(s.paddingLeft).toBeUndefined();
    expect(s.textIndent).toBeUndefined();
  });
});
