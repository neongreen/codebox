# codebox

Xcode-style code blocks for React. Shiki syntax highlighting, **structure-aware
soft wrapping**, proportional string bodies, repeated comment markers — and it
never chokes on malformed syntax.

**[Live demo & examples →](https://neongreen.github.io/codebox/)** — every
language, plus diverse real-world snippets showing the wrapping in action.

```bash
bun add @neongreen/codebox
```

## Why

Most code-block components word-wrap long lines back to column 0, which shreds
the indentation and makes wrapped code (and long string literals) hard to read.
codebox borrows the trick real editors use: when a line wraps, continuation
lines stay lined up **under the code** instead of resetting to the left margin.

But it goes further than leading whitespace. codebox reads each line's structure
from the syntax tokens, so wrapping is preserved for **every indented
situation**:

- **Function arguments / arrays / objects** — wrapped continuations align under
  the first argument (just inside the opening bracket).
- **String bodies** — long string literals wrap as proportional "prose" text,
  aligned under the opening quote, so they read like text blocks instead of a
  ragged monospace mess.
- **Comments** — wrapped comments align under the comment text, and the marker
  (`//`, `#`, `/*`, …) is repeated at the start of every continuation line so it
  keeps reading like a comment.

It also tolerates broken input. Classification and highlighting run through
Shiki's TextMate tokenizer — a lexer, not a parser — so unterminated strings,
mismatched braces, and half-typed expressions highlight what they can and render
the rest verbatim. It never throws.

> **On "tree-sitter":** the structure (which spans are strings, comments,
> brackets) comes from real TextMate scopes via Shiki, not regex hacks and not a
> separate tree-sitter wasm grammar. Same robustness on malformed input, far
> lighter to ship.

## Usage

```tsx
import { CodeBox } from "@neongreen/codebox";
import "@neongreen/codebox/styles.css";

export function Example() {
  return (
    <CodeBox
      code={`function greet(name: string) {\n  return "Hello, " + name;\n}`}
      lang="typescript"
      theme="github-light"
    />
  );
}
```

`CodeBox` highlights asynchronously (Shiki loads grammars on demand) and shows
the raw code as plain text until it's ready, so there's never a blank flash.

### Props

| prop              | type                       | default          | notes                                                              |
| ----------------- | -------------------------- | ---------------- | ------------------------------------------------------------------ |
| `code`                | `string`      | —                | source to render                                                   |
| `lang`                | `string`      | —                | `typescript`, `javascript`, `tsx`, `jsx`, `css`, `json`, `yaml` (+ aliases like `ts`, `js`, `yml`) |
| `theme`               | `string`      | `"github-light"` | `github-light` or `github-dark` (bundled)                         |
| `wrap`                | `boolean`     | `true`           | structure-aware soft wrap; `false` = horizontal scroll            |
| `hangingIndent`       | `number`      | `0`              | extra columns added to wrapped continuation lines                 |
| `proseStrings`        | `boolean`     | `true`           | render string-literal bodies in a proportional font               |
| `repeatCommentMarker` | `boolean`     | `true`           | repeat `//` / `#` / `/*` at the start of each wrapped comment line |
| `tokenStyles`         | `TokenStyles` | —                | per-kind style overrides: `{ comment?, string?, code? }`          |
| `renderToken`         | `function`    | —                | escape hatch to fully control how a token renders                 |
| `tabSize`             | `number`      | `2`              | columns a tab counts as when measuring indentation                |
| `continuationIndent`  | `number`      | `tabSize`        | columns a continuation falls in by when alignment alone wouldn't put it past the line's first character |
| `showLineNumbers`     | `boolean`     | `false`          | render a line-number gutter                                       |
| `fallback`            | `ReactNode`   | plain code       | shown while the highlighter loads                                 |

### Pre-highlight for SSR

If you already have highlighted data (e.g. computed on the server), render it
synchronously with `RenderedCode`:

```tsx
import { highlightToLines, RenderedCode } from "@neongreen/codebox";

const data = await highlightToLines(code, { lang: "typescript" });
// later, in a synchronous render:
<RenderedCode data={data} wrap hangingIndent={2} />;
```

## Customizing comments and strings

Style by kind with `tokenStyles`, or target the CSS classes
(`.codebox__tok--comment`, `.codebox__tok--string`) directly:

```tsx
<CodeBox
  code={code}
  lang="ts"
  tokenStyles={{ comment: { fontStyle: "italic", opacity: 0.6 } }}
/>
```

The proportional font for string bodies is the `--codebox-prose-font` CSS
variable — override it to whatever you like. For total control, `renderToken`
lets you replace token rendering entirely.

**Matching the size automatically.** A proportional font set at the same
`font-size` as the monospace code usually *looks* smaller, because its x-height
per em differs. So on mount the renderer measures the real x-height of both the
code font and the prose font (canvas glyph metrics, subpixel-accurate) and sets
`--codebox-prose-font-size-measured` so the prose body renders at the **same
x-height** as the surrounding code — they look the same size. It re-measures on
resize and once web fonts swap in. Set `--codebox-prose-font-size` yourself to
pin an explicit size; your value wins and the measurement is skipped.

Matching x-height can scale the prose *font-size* above the code's (a serif, say,
has a smaller x-height per em), so the prose token uses `line-height: 1` to keep
every row the same height — the string row never grows taller than the code rows.
The only way to outgrow that is a prose face so low-x-height that its matched size
exceeds the line strut (`font-size × --codebox-line-height`); pin
`--codebox-prose-font-size` if you hit that.

## How structure-aware wrapping works

Each line gets a CSS hanging indent: a negative `text-indent` pulls the
**first** visual line back to column 0 (so the line's own leading whitespace
renders normally), while `padding-left` pushes every **wrapped** continuation
line in to line up. The alignment anchor is found from the line's tokens: the
first opening bracket, the start of a string body, the start of comment text,
or — failing those — the leading indent.

**The indent is a real measurement, not a column count.** The amount is
`var(--codebox-wrap-indent, <ch fallback>)`. SSR emits the `ch` fallback —
the anchor's character column expressed in `ch`, which is exact for monospace
and needs no JavaScript. On mount the renderer measures the anchor glyph's
actual pixel offset in the applied font (via collapsed-caret `Range` geometry)
and sets `--codebox-wrap-indent`, so continuations line up under the anchor in
**any** typeface — proportional, ligatured or mixed — not just monospace. It
re-measures on resize and once web fonts swap in.

A hard rule underpins all of this: **a continuation is always indented strictly
more than the line's first character.** Structural alignment usually satisfies
it; when it wouldn't (a plain expression, or a line that is itself a string or
comment body), the continuation falls in by `continuationIndent` columns so a
wrap can never sit at or left of where the statement began.

The hanging indent is capped at `--codebox-max-wrap` (default `66cqw`, i.e. 66%
of the box's own inline size)
so a deep alignment in a narrow container degrades gracefully instead of wrapping
one character per line. Comment markers are repeated on wrapped lines via a small
client-side overlay
(SSR renders the marker once; it's enhanced on mount). When `wrap` is off, lines
use `white-space: pre` and the container scrolls horizontally.

## Supported languages

`typescript`, `javascript`, `tsx`, `jsx`, `css`, `json`, `yaml` — plus aliases
(`ts`, `js`, `yml`, `jsonc`, …). Adding more is a one-line change; Shiki ships
grammars for hundreds.

## Roadmap

- **Justified prose blocks** — optional full justification / measured reflow of
  string and comment bodies so they form clean rectangular text blocks.
- More bundled themes (currently `github-light` / `github-dark`).

## Development

```bash
bun install
bun test          # unit + render + real-browser layout tests
bun run typecheck
bun run demo:dev  # the demo site
```

The test suite covers the stated properties: indentation math, highlighting
across every supported language, malformed-input robustness, the rendered DOM,
and a headless-Chrome layout test that measures wrapped-line geometry to prove
continuations actually line up under the code. The browser test auto-skips if no
Chrome is available.

## License

MIT
