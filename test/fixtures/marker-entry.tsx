// Test fixture: a real client mount of RenderedCode so useLayoutEffect runs and
// the comment-marker overlay is exercised. Bundled by marker.browser.test.tsx.
import { createRoot } from "react-dom/client";
import { RenderedCode } from "../../src/CodeBox";
import type { HighlightedCode } from "../../src/types";

declare global {
  interface Window {
    __CB_DATA__: HighlightedCode;
  }
}

createRoot(document.getElementById("root")!).render(
  <RenderedCode data={window.__CB_DATA__} wrap repeatCommentMarker />,
);
