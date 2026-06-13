import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { highlightToLines } from "../src/highlight";

/**
 * Proves the comment-marker repeat: when a line comment word-wraps, its marker
 * (#, //, …) is repeated at the start of every continuation line. This is a
 * client-side enhancement (it measures layout), so we bundle a real React mount
 * and run it in headless Chrome, served over HTTP.
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

describeFn("comment marker repeat (real browser mount)", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let bundle = "";
  let dataJson = "{}";
  let width = 240;

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
            .codebox { width: ${width}px; font-size: 13px; padding: 0; }
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

  async function mount(code: string, w: number) {
    width = w;
    dataJson = JSON.stringify(
      await highlightToLines(code, { lang: "typescript" }),
    );
    const p = await browser.newPage();
    await p.goto(`http://localhost:${server.port}/`, {
      waitUntil: "networkidle0",
    });
    await new Promise((r) => setTimeout(r, 300));
    const result = await p.evaluate(() => {
      const markers = [
        ...document.querySelectorAll(".codebox__comment-marker"),
      ] as HTMLElement[];
      const content = document.querySelector(
        ".codebox__content--comment",
      ) as HTMLElement | null;
      let visualLines = 0;
      if (content) {
        const tops = new Set<number>();
        content.querySelectorAll(".codebox__tok").forEach((tok) => {
          for (const r of tok.getClientRects()) {
            if (r.width > 0.5) tops.add(Math.round(r.top));
          }
        });
        visualLines = tops.size;
      }
      return {
        markerCount: markers.length,
        markerTexts: markers.map((m) => m.textContent),
        visualLines,
        mounted: !!document.querySelector(".codebox"),
      };
    });
    await p.close();
    return result;
  }

  test("a wrapped line comment repeats its marker on every continuation line", async () => {
    const comment = "  // " + "word ".repeat(40).trim();
    const m = await mount(comment, 240);
    expect(m.mounted).toBe(true);
    expect(m.visualLines).toBeGreaterThan(1);
    expect(m.markerCount).toBe(m.visualLines - 1);
    expect(m.markerTexts.every((t) => t === "//")).toBe(true);
  });

  test("no markers when the comment fits on one line", async () => {
    const m = await mount("// short", 600);
    expect(m.mounted).toBe(true);
    expect(m.visualLines).toBe(1);
    expect(m.markerCount).toBe(0);
  });
});
