import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import puppeteer, { type Browser } from "puppeteer-core";
import { RenderedCode } from "../src/CodeBox";
import { highlightToLines } from "../src/highlight";

/**
 * Real-layout proof of the headline property: when an indented line soft-wraps,
 * the continuation lines line up under the code instead of resetting to col 0.
 * jsdom can't do this — it does no layout — so we drive a real headless Chrome
 * and measure the geometry of the wrapped fragments.
 */

const CHROME_CANDIDATES = [
  process.env.CODEBOX_CHROME,
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-148.0.7778.167/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
].filter(Boolean) as string[];

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
const stylesCss = await Bun.file(
  new URL("../src/styles.css", import.meta.url),
).text();

async function page(
  code: string,
  props: Record<string, unknown>,
  width = 260,
) {
  const data = await highlightToLines(code, { lang: "typescript" });
  const markup = renderToStaticMarkup(
    createElement(RenderedCode, { data, ...props }),
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${stylesCss}
    body { margin: 0; }
    .codebox { width: ${width}px; font-size: 13px; padding: 0; border-radius: 0; }
  </style></head><body>${markup}</body></html>`;
}

const describeFn = chromePath ? describe : describe.skip;

describeFn("indent-aware wrapping (real browser layout)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: chromePath!,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  // A long, deeply-indented single line that is guaranteed to wrap several
  // times inside the 260px box. Indent is 6 columns.
  const INDENT = 6;
  const longLine =
    " ".repeat(INDENT) + "const result = " + "value + ".repeat(30) + "end;";

  async function measure(props: Record<string, unknown>, line = longLine) {
    const p = await browser.newPage();
    await p.setContent(await page(line, props), { waitUntil: "load" });
    const result = await p.evaluate(() => {
      const cb = document.querySelector(".codebox") as HTMLElement;
      const content = document.querySelector(
        ".codebox__content",
      ) as HTMLElement;

      // Measure the pixel width of one monospace character in this context.
      const cbStyle = getComputedStyle(cb);
      const probe = document.createElement("span");
      probe.style.fontFamily = cbStyle.fontFamily;
      probe.style.fontSize = cbStyle.fontSize;
      probe.style.whiteSpace = "pre";
      probe.textContent = "0".repeat(100);
      document.body.appendChild(probe);
      const chPx = probe.getBoundingClientRect().width / 100;
      probe.remove();

      // Range rects come one-per-token, so collapse them into visual lines by
      // grouping on their vertical position; take the leftmost x of each line.
      const range = document.createRange();
      range.selectNodeContents(content);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
      const byTop = new Map<number, number>();
      for (const r of rects) {
        const key = Math.round(r.top);
        const cur = byTop.get(key);
        if (cur === undefined || r.left < cur) byTop.set(key, r.left);
      }
      const lefts = [...byTop.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((e) => e[1]);
      return {
        chPx,
        rectCount: lefts.length,
        lefts,
      };
    });
    await p.close();
    return result;
  }

  test("wrapped continuations are indented under the code", async () => {
    const m = await measure({ wrap: true });

    // It actually wrapped into multiple visual lines.
    expect(m.rectCount).toBeGreaterThan(1);

    const first = m.lefts[0]!;
    const continuations = m.lefts.slice(1);

    // Every continuation line is indented further right than the first line...
    for (const left of continuations) {
      expect(left).toBeGreaterThan(first + 1);
    }

    // ...by approximately INDENT character widths (Xcode-style alignment).
    const expected = INDENT * m.chPx;
    for (const left of continuations) {
      expect(Math.abs(left - first - expected)).toBeLessThan(m.chPx); // within 1ch
    }
  });

  test("extra hangingIndent pushes continuations out further", async () => {
    const extra = 4;
    const m = await measure({ wrap: true, hangingIndent: extra });
    expect(m.rectCount).toBeGreaterThan(1);
    const delta = m.lefts[1]! - m.lefts[0]!;
    const expected = (INDENT + extra) * m.chPx;
    expect(Math.abs(delta - expected)).toBeLessThan(m.chPx);
  });

  test("wrap off: the line does not wrap (single fragment)", async () => {
    const m = await measure({ wrap: false });
    expect(m.rectCount).toBe(1);
  });

  test("function arguments stay aligned under the first arg when wrapped", async () => {
    // A balanced but long call. '(' is at index `prefix.length`; args align
    // one column further in.
    const prefix = "const result = compute";
    const argsLine =
      prefix + "(" + Array.from({ length: 40 }, (_, i) => `arg${i}`).join(", ") + ")";
    const openCol = prefix.length; // 0-based column of '('
    const m = await measure({ wrap: true }, argsLine);
    expect(m.rectCount).toBeGreaterThan(1);
    const expected = (openCol + 1) * m.chPx;
    for (const left of m.lefts.slice(1)) {
      expect(Math.abs(left - m.lefts[0]! - expected)).toBeLessThan(m.chPx);
    }
  });
});
