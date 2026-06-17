# CLAUDE.md

Guidance for AI agents (and humans) working in this repository.

## Mandatory: show screenshots for every change

**Whenever you change anything that affects what the rendered output looks like
— CSS, layout, measurement, token rendering, the demo — you MUST capture a
screenshot of the result and show it to the user.** Prefer a before/after pair
so the effect is visible. This is not optional and is not limited to "visual"
tasks: font sizing, wrapping, indentation, and spacing are all visual, and
regressions in them are easy to miss without a picture. If a change genuinely
cannot affect rendering (e.g. a typo in a comment, a README edit), say so
explicitly instead of skipping silently.

## How to take a screenshot of the rendered component

The headline behaviors — structural wrap indent, repeated comment markers, and
prose-font x-height matching — are **client-side measurements that run in
`useLayoutEffect`**. `renderToStaticMarkup` / SSR markup does **not** trigger
them, so a static-HTML screenshot shows the pre-measurement fallback, not the
real result. You must do a **real React client mount in a real browser**.

The recipe (this is exactly how the prose-font screenshots were made):

1. **Get Chrome.** Look for `~/.cache/puppeteer/chrome/*/chrome-linux64/chrome`.
   If missing: `bunx puppeteer browsers install chrome`. The browser layout
   tests (`test/*.browser.test.*`) use `puppeteer-core` the same way and
   auto-skip when no Chrome is found.

2. **Write a tiny entry file** that mounts the component (kept separate from the
   driver script — a self-bundling script would pull puppeteer/node deps into
   the browser bundle and fail):

   ```tsx
   // shot-entry.tsx
   import { createRoot } from "react-dom/client";
   import { RenderedCode } from "./src/CodeBox";
   import type { HighlightedCode } from "./src/types";
   createRoot(document.getElementById("root")!).render(
     <RenderedCode
       data={(window as unknown as { __CB_DATA__: HighlightedCode }).__CB_DATA__}
       wrap
       proseStrings
     />,
   );
   ```

3. **Bundle, serve over HTTP, drive Chrome.** Key points the existing
   `marker.browser.test.tsx` and the prose work rely on:
   - `Bun.build({ entrypoints: ["shot-entry.tsx"], target: "browser" })`.
   - **`built.outputs[0]!.text()` returns a Promise — you must `await` it.**
     (Forgetting this serves the string `[object Promise]` as JS and the page
     dies with `Unexpected identifier 'Promise'`.)
   - Inline `src/styles.css` into the page `<style>`.
   - Set `window.__CB_DATA__` from `highlightToLines(code, { lang })` via a
     classic `<script>` that loads *before* the module bundle.
   - `page.goto(url, { waitUntil: "networkidle0" })`, then wait ~300ms so the
     layout effects and `ResizeObserver` settle before screenshotting.
   - `page.setViewport({ ..., deviceScaleFactor: 2 })` for a crisp image.

   ```ts
   // shot.ts
   import puppeteer from "puppeteer-core";
   import { highlightToLines } from "./src/highlight";

   const chromePath = "/root/.cache/puppeteer/chrome/<version>/chrome-linux64/chrome";
   const stylesCss = await Bun.file("src/styles.css").text();
   const code = `const a = 1;\nconst s = "a string body of prose text";\nconst b = 2;`;

   const built = await Bun.build({ entrypoints: ["shot-entry.tsx"], target: "browser", minify: true });
   if (!built.success) throw new AggregateError(built.logs, "bundle failed");
   const bundle = await built.outputs[0]!.text(); // <-- await!
   const dataJson = JSON.stringify(await highlightToLines(code, { lang: "typescript" }));

   const server = Bun.serve({ port: 0, fetch(req) {
     const u = new URL(req.url);
     if (u.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
     if (u.pathname === "/data.js")   return new Response(`window.__CB_DATA__ = ${dataJson};`, { headers: { "content-type": "text/javascript" } });
     return new Response(`<!doctype html><meta charset=utf-8><style>${stylesCss}
       body{margin:0;background:#eee} .codebox{width:520px;font-size:15px;border:1px solid #ccc}</style>
       <div id=root></div>
       <script src=/data.js></script><script type=module src=/bundle.js></script>`,
       { headers: { "content-type": "text/html" } });
   }});

   const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
   const p = await browser.newPage();
   await p.setViewport({ width: 600, height: 240, deviceScaleFactor: 2 });
   await p.goto(`http://localhost:${server.port}/`, { waitUntil: "networkidle0" });
   await new Promise((r) => setTimeout(r, 300));
   await p.screenshot({ path: "/tmp/shot.png" });
   await browser.close();
   server.stop(true);
   ```

4. **Run it, show the PNG to the user, then clean up** the temporary
   `shot-entry.tsx` / `shot.ts` (do not commit throwaway harness files).

To compare configurations (e.g. an override), re-render with a different
`--codebox-*` CSS variable on `.codebox` and take a second shot.

## Invariant: a single line can mix fonts, including non-monospace ones

**Never assume a line is uniform-width or monospace.** By design, string bodies
render in a *proportional* prose font at their own size (`proseStrings`), while
the surrounding code is monospace — so one visual line routinely mixes families
**and** sizes, and weights/slants vary per token. Anything that reasons about
width must be engineered for this:

- **Measure in pixels, in the actual fonts — never in character columns.** A
  "column" is meaningless across a proportional run. The chain reflow
  (`src/reflow.ts`) takes an injected `Measurer` that measures each run in its
  real font; the React layer builds it in `useReflowMeasure` (CodeBox.tsx).
- **Reuse the existing measurement primitives; don't add a third.** Glyph
  advances of *already-rendered* text come from DOM caret offsets
  (`measurePrefixPx`) — exact for proportional fonts, ligatures, and tabs.
  Widths of *hypothetical* (not-yet-rendered) text come from the shared
  offscreen `measureCanvas` (`textPx`, `xHeightPerPx`), using the real computed
  fonts and the `--codebox-prose-font*` variables. Pick whichever fits whether
  the text is on screen yet; don't reinvent either.
- Tabs, ligatures, and per-token weight/italic all change advance width too.

## Project basics

```bash
bun install
bun test          # unit + render + real-browser layout tests (browser tests skip without Chrome)
bun run typecheck
bun run demo:dev  # the demo site
```

Source lives in `src/`; the published demo build is in `docs/`. Rendering /
measurement logic is in `src/CodeBox.tsx`; structural analysis in
`src/classify.ts`; default styles and CSS custom properties in `src/styles.css`.
