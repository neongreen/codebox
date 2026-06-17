import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { highlightToLines } from "../src/highlight";

/**
 * Proves the default prose-font sizing: on mount the renderer measures the real
 * x-height of the code font and the prose font and sets
 * --codebox-prose-font-size-measured so a proportional string body has the
 * *same x-height* as the surrounding monospace (instead of looking smaller).
 * This is a client-side measurement (canvas glyph metrics), so we bundle a real
 * React mount and run it in headless Chrome. A user-supplied
 * --codebox-prose-font-size must still win and skip the measurement.
 */

const chromePath = [
  process.env.CODEBOX_CHROME,
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-148.0.7778.167/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
].find((p): p is string => !!p && existsSync(p));

const stylesCss = await Bun.file(
  new URL("../src/styles.css", import.meta.url),
).text();

async function bundleEntry(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      new URL("./fixtures/prose-entry.tsx", import.meta.url).pathname,
    ],
    target: "browser",
    minify: true,
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  return built.outputs[0]!.text();
}

const describeFn = chromePath ? describe : describe.skip;

describeFn("prose font x-height matching (real browser mount)", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let bundle = "";
  let dataJson = "{}";
  let extraCss = "";

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
            .codebox { width: 600px; font-size: 13px; padding: 0; ${extraCss} }
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

  async function mount(css: string) {
    extraCss = css;
    dataJson = JSON.stringify(
      await highlightToLines(
        `const message = "a long string body that reads like prose text here";`,
        { lang: "typescript" },
      ),
    );
    const p = await browser.newPage();
    await p.goto(`http://localhost:${server.port}/`, {
      waitUntil: "networkidle0",
    });
    await new Promise((r) => setTimeout(r, 300));
    const result = await p.evaluate(() => {
      const codeTok = document.querySelector(
        ".codebox__tok--code",
      ) as HTMLElement;
      const proseTok = document.querySelector(
        ".codebox__tok--prose",
      ) as HTMLElement;
      // Measure the actual x-height (px) a token renders at, from glyph metrics.
      const xHeight = (el: HTMLElement) => {
        const cs = getComputedStyle(el);
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} 256px ${cs.fontFamily}`;
        const perPx = ctx.measureText("x").actualBoundingBoxAscent / 256;
        return perPx * parseFloat(cs.fontSize);
      };
      return {
        mounted: !!document.querySelector(".codebox"),
        proseFontSize: parseFloat(getComputedStyle(proseTok).fontSize),
        codeXHeight: xHeight(codeTok),
        proseXHeight: xHeight(proseTok),
      };
    });
    await p.close();
    return result;
  }

  test("by default the prose font is sized to the code font's x-height", async () => {
    const m = await mount("");
    expect(m.mounted).toBe(true);
    // Prose and code lowercase letters end up the same height (subpixel).
    expect(Math.abs(m.codeXHeight - m.proseXHeight)).toBeLessThan(0.1);
    // The match was achieved by *growing* the prose past the old 0.9em default
    // (the sans x-height is smaller per em than the mono here).
    expect(m.proseFontSize).toBeGreaterThan(13 * 0.9);
  });

  test("an explicit --codebox-prose-font-size override is respected", async () => {
    const m = await mount("--codebox-prose-font-size: 0.5em;");
    expect(m.mounted).toBe(true);
    // Override wins over the measurement: 0.5em of 13px.
    expect(m.proseFontSize).toBeCloseTo(6.5, 1);
  });
});
