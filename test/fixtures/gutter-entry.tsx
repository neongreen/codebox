// Test fixture: a real client mount of RenderedCode with the line-number gutter
// toggled via a window flag, so the layout effect that measures the reflow width
// budget runs against a real gutter. Bundled by gutter.browser.test.tsx.
import { createRoot } from "react-dom/client";
import { RenderedCode } from "../../src/CodeBox";
import type { HighlightedCode } from "../../src/types";

declare global {
  interface Window {
    __CB_DATA__: HighlightedCode;
    __CB_LN__: boolean;
  }
}

createRoot(document.getElementById("root")!).render(
  <RenderedCode
    data={window.__CB_DATA__}
    wrap
    showLineNumbers={window.__CB_LN__}
    proseStrings={false}
  />,
);
