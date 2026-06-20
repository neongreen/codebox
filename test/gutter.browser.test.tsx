import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { highlightToLines } from "../src/highlight";

/**
 * The chain-reflow width budget must subtract the line-number gutter. The gutter
 * is padding on each `.codebox__line`, not on the `<pre>`, so a budget measured
 * from the `<pre>` alone over-counts by the gutter and leaves lines flat that
 * then overflow the real text area and fall back to ugly CSS soft-wrapping
 * (a closing `}` stranded on its own line, a chain wrapped mid-call, a ternary
 * operand flush under the statement). Reproducing that needs the real
 * client-side measurement, so this is a true browser mount.
 *
 * The test uses an exaggerated gutter so the effect is unambiguous regardless of
 * the host's exact font metrics: at the chosen width the chain fits the codebox
 * but NOT the gutter-reduced text area, so it must reflow only when numbered.
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
      new URL("./fixtures/gutter-entry.tsx", import.meta.url).pathname,
    ],
    target: "browser",
    minify: true,
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  return built.outputs[0]!.text();
}

const describeFn = chromePath ? describe : describe.skip;

describeFn("reflow budget accounts for the line-number gutter", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let bundle = "";
  let dataJson = "{}";
  let lineNumbers = true;
  // A monospace font keeps the chain width predictable; the box is wide enough
  // that the chain fits it, while the (exaggerated) gutter eats enough that the
  // remaining text area does not.
  const width = 560;
  const gutter = 320;

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
          return new Response(
            `window.__CB_DATA__ = ${dataJson};window.__CB_LN__ = ${lineNumbers};`,
            { headers: { "content-type": "text/javascript" } },
          );
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><style>
            ${stylesCss}
            body { margin: 0; }
            .codebox {
              width: ${width}px; font-size: 16px; padding: 0;
              --codebox-gutter: ${gutter}px;
              --codebox-font: monospace;
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

  /** Mount one source line and report how many `.codebox__line` elements (i.e.
   *  reflow-produced visual lines) and how many leading-`.` chain links appear. */
  async function mount(code: string, ln: boolean) {
    dataJson = JSON.stringify(
      await highlightToLines(code, { lang: "typescript" }),
    );
    lineNumbers = ln;
    const p = await browser.newPage();
    await p.goto(`http://localhost:${server.port}/`, {
      waitUntil: "networkidle0",
    });
    await new Promise((r) => setTimeout(r, 400));
    const result = await p.evaluate(() => {
      const lines = [...document.querySelectorAll(".codebox__line")];
      const chainLinks = lines.filter((l) =>
        (l.textContent ?? "").trimStart().startsWith("."),
      ).length;
      return { lineCount: lines.length, chainLinks };
    });
    await p.close();
    return result;
  }

  const chain = "const reversed = cleaned.split('').reverse().join('');";

  test("a chain that fits the box but not the gutter-reduced area reflows when numbered", async () => {
    const m = await mount(chain, true);
    // It actually broke into a stacked `.method()` chain.
    expect(m.lineCount).toBeGreaterThan(1);
    expect(m.chainLinks).toBeGreaterThanOrEqual(2);
  });

  test("control: the same chain at the same width stays flat without a gutter", async () => {
    const m = await mount(chain, false);
    expect(m.lineCount).toBe(1);
    expect(m.chainLinks).toBe(0);
  });
});
