import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { highlightToLines } from "../src/highlight";

/**
 * Proves the headline alignment is font-agnostic: under a PROPORTIONAL font,
 * wrapped continuations line up under the real anchor glyph (the first argument
 * of a call), not at the `ch`-based column that only happens to be right for
 * monospace. The renderer measures the anchor's pixel offset on mount and feeds
 * it back as --codebox-wrap-indent, so this needs a real React mount in Chrome.
 */

const chromePath = [
  process.env.CODEBOX_CHROME,
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-148.0.7778.167/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
].find((p): p is string => !!p && existsSync(p));

const stylesCss = await Bun.file(
  new URL("../src/styles.css", import.meta.url),
).text();

async function bundleEntry(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      new URL("./fixtures/marker-entry.tsx", import.meta.url).pathname,
    ],
    target: "browser",
    minify: true,
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  return built.outputs[0]!.text();
}

const describeFn = chromePath ? describe : describe.skip;

describeFn("font-agnostic wrap alignment (real browser mount)", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let bundle = "";
  let dataJson = "{}";
  // A generic proportional family ("sans-serif" -> DejaVu Sans on Linux Chrome):
  // glyph advances vary, so the ch approximation would be visibly off.
  let fontFamily = "sans-serif";
  let width = 320;

  beforeAll(async () => {
    bundle = await bundleEntry();
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === "/data.js")
          return new Response(`window.__CB_DATA__ = ${dataJson};`, {
            headers: { "content-type": "text/javascript" },
          });
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><style>
            ${stylesCss}
            body { margin: 0; }
            .codebox {
              width: ${width}px; font-size: 16px; padding: 0;
              --codebox-font: ${fontFamily};
            }
          </style></head><body>
            <div id="root"></div>
            <script src="/data.js"></script>
            <script type="module" src="/bundle.js"></script>
          </body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    browser = await puppeteer.launch({
      executablePath: chromePath!,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function mount(code: string, anchorChars: number) {
    dataJson = JSON.stringify(
      await highlightToLines(code, { lang: "typescript" }),
    );
    const p = await browser.newPage();
    await p.goto(`http://localhost:${server.port}/`, {
      waitUntil: "networkidle0",
    });
    await new Promise((r) => setTimeout(r, 400));
    const result = await p.evaluate((anchorChars: number) => {
      const content = document.querySelector(
        ".codebox__content",
      ) as HTMLElement;
      const base = content.getBoundingClientRect();

      // Pixel width of one "0" glyph == the meaning of 1ch in this font.
      const probe = document.createElement("span");
      const cs = getComputedStyle(content);
      probe.style.font = cs.font;
      probe.style.whiteSpace = "pre";
      probe.textContent = "0".repeat(100);
      document.body.appendChild(probe);
      const chPx = probe.getBoundingClientRect().width / 100;
      probe.remove();

      // Real pixel offset of the anchor: measure the first `anchorChars` chars.
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        nodes.push(n as Text);
      let remaining = anchorChars;
      let endNode = nodes[nodes.length - 1]!;
      let endOffset = endNode.length;
      for (const node of nodes) {
        if (remaining <= node.length) {
          endNode = node;
          endOffset = remaining;
          break;
        }
        remaining -= node.length;
      }
      const r = document.createRange();
      r.setStart(nodes[0]!, 0);
      r.setEnd(endNode, endOffset);
      const anchorPx = r.getBoundingClientRect().width;

      // Leftmost x of each visual line.
      const range = document.createRange();
      range.selectNodeContents(content);
      const byTop = new Map<number, number>();
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0.5) continue;
        const key = Math.round(rect.top);
        const cur = byTop.get(key);
        if (cur === undefined || rect.left < cur) byTop.set(key, rect.left);
      }
      const lefts = [...byTop.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((e) => e[1] - base.left);

      return { chPx, anchorPx, lefts };
    }, anchorChars);
    await p.close();
    return result;
  }

  test("continuations align to the measured anchor, not the ch column", async () => {
    const prefix = "const result = compute";
    const code =
      prefix +
      "(" +
      Array.from({ length: 30 }, (_, i) => `argument${i}`).join(", ") +
      ")";
    const anchorChars = prefix.length + 1; // first char after '('
    const m = await mount(code, anchorChars);

    // It wrapped.
    expect(m.lefts.length).toBeGreaterThan(1);
    // First visual line is flush.
    expect(Math.abs(m.lefts[0]!)).toBeLessThan(1);

    // The font is genuinely proportional, so the ch-based guess is materially
    // wrong — this is exactly the case the old approach broke on.
    const chGuess = anchorChars * m.chPx;
    expect(Math.abs(chGuess - m.anchorPx)).toBeGreaterThan(m.chPx);

    // Every continuation lines up under the real anchor glyph (within a px or
    // two of sub-pixel rounding), NOT at the ch column.
    for (const left of m.lefts.slice(1)) {
      expect(Math.abs(left - m.anchorPx)).toBeLessThan(2);
    }
  });
});
