# codebox

Xcode-style code blocks for React. Shiki syntax highlighting, **indent-aware
soft wrapping**, and it never chokes on malformed syntax.

**[Live demo →](https://neongreen.github.io/codebox/)**

```bash
bun add @neongreen/codebox
```

## Why

Most code-block components word-wrap long lines back to column 0, which shreds
the indentation and makes wrapped code (and long string literals) hard to read.
codebox borrows the trick real editors like Xcode use: when a line wraps, the
continuation lines stay lined up **under the code** instead of resetting to the
left margin. Indentation survives.

It also tolerates broken input. Highlighting runs through Shiki's TextMate
tokenizer — a lexer, not a parser — so unterminated strings, mismatched braces,
and half-typed expressions highlight what they can and render the rest verbatim.
It never throws.

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
| `code`            | `string`                   | —                | source to render                                                   |
| `lang`            | `string`                   | —                | `typescript`, `javascript`, `tsx`, `jsx`, `css`, `json`, `yaml` (+ aliases like `ts`, `js`, `yml`) |
| `theme`           | `string`                   | `"github-light"` | any Shiki theme name                                               |
| `wrap`            | `boolean`                  | `true`           | soft-wrap with indent-aware hanging indent; `false` = scroll       |
| `hangingIndent`   | `number`                   | `0`              | extra columns added to wrapped continuation lines                  |
| `tabSize`         | `number`                   | `2`              | columns a tab counts as when measuring indentation                 |
| `showLineNumbers` | `boolean`                  | `false`          | render a line-number gutter                                        |
| `fallback`        | `ReactNode`                | plain code       | shown while the highlighter loads                                  |

### Pre-highlight for SSR

If you already have highlighted data (e.g. computed on the server), render it
synchronously with `RenderedCode`:

```tsx
import { highlightToLines, RenderedCode } from "@neongreen/codebox";

const data = await highlightToLines(code, { lang: "typescript" });
// later, in a synchronous render:
<RenderedCode data={data} wrap hangingIndent={2} />;
```

## How indent-aware wrapping works

Each line gets a CSS hanging indent of `indent + hangingIndent` columns: a
negative `text-indent` pulls the **first** visual line back to column 0 (so the
line's own leading whitespace renders normally), while `padding-left` pushes
every **wrapped** continuation line in to line up under the code. With
`hangingIndent: 0` the wrap aligns exactly under the first non-whitespace
character. When `wrap` is off, lines use `white-space: pre` and the container
scrolls horizontally.

## Supported languages

`typescript`, `javascript`, `tsx`, `jsx`, `css`, `json`, `yaml` — plus aliases
(`ts`, `js`, `yml`, `jsonc`, …). Adding more is a one-line change; Shiki ships
grammars for hundreds.

## Roadmap

- **Proportional string-literal blocks** — render the inside of string literals
  as nicely-wrapped proportional text while code stays monospace (the planned
  headline feature; will use tree-sitter to locate string nodes robustly).

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
