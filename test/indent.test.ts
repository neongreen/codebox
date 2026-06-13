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
  test("wrap on: hanging indent equals the line indent", () => {
    const s = lineStyle(4, 0, true);
    expect(s.whiteSpace).toBe("pre-wrap");
    expect(s.paddingLeft).toBe("4ch");
    expect(s.textIndent).toBe("-4ch");
  });

  test("wrap on: extra hanging indent is added on top of the indent", () => {
    const s = lineStyle(4, 2, true);
    expect(s.paddingLeft).toBe("6ch");
    expect(s.textIndent).toBe("-6ch");
  });

  test("padding and text-indent are equal-and-opposite so line 1 stays flush", () => {
    // This is the core invariant: first visual line begins at column 0,
    // wrapped continuations begin at `total`.
    for (const [indent, hang] of [
      [0, 0],
      [2, 0],
      [8, 4],
    ] as const) {
      const s = lineStyle(indent, hang, true);
      const total = indent + hang;
      expect(s.paddingLeft).toBe(`${total}ch`);
      expect(s.textIndent).toBe(`${-total}ch`);
    }
  });

  test("wrap off: no hanging indent, uses pre (scroll mode)", () => {
    const s = lineStyle(4, 0, false);
    expect(s.whiteSpace).toBe("pre");
    expect(s.paddingLeft).toBeUndefined();
    expect(s.textIndent).toBeUndefined();
  });
});
