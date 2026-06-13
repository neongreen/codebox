import { useState } from "react";
import { CodeBox } from "../src/index";

const THEMES = ["github-light", "github-dark"] as const;

const SAMPLES: { lang: string; label: string; code: string }[] = [
  {
    lang: "typescript",
    label: "TypeScript",
    code: `interface User {
  id: number;
  name: string;
}

// A long string literal that would normally word-wrap into an ugly mess and
// destroy the indentation of the code around it — watch what happens instead.
export function greet(user: User): string {
  const message = "Hello there, " + user.name + "! Welcome back to the application. We have missed you and there is a lot of new stuff waiting for you to discover today.";
  return message;
}`,
  },
  {
    lang: "javascript",
    label: "JavaScript",
    code: `const numbers = [1, 2, 3, 4, 5];

const doubled = numbers
  .filter((n) => n % 2 === 1)
  .map((n) => n * 2)
  .reduce((acc, n) => acc + n, 0);

console.log(\`The sum of the doubled odds is \${doubled} which is honestly a delightful little number to end on.\`);`,
  },
  {
    lang: "tsx",
    label: "TSX",
    code: `function Card({ title }: { title: string }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p>This paragraph is intentionally long so that it has to wrap when the container gets narrow, demonstrating indentation that survives.</p>
    </div>
  );
}`,
  },
  {
    lang: "css",
    label: "CSS",
    code: `.codebox {
  font-family: ui-monospace, monospace;
  /* A comment long enough to wrap, kept aligned under its indentation rather than sprawling back to the left margin like a normal word-wrap would do. */
  font-feature-settings: "liga" 0;
}`,
  },
  {
    lang: "json",
    label: "JSON",
    code: `{
  "name": "@neongreen/codebox",
  "private": false,
  "description": "A fairly long description value that wraps onto multiple visual lines while staying tucked under the opening quote instead of unindenting.",
  "keywords": ["react", "shiki", "code"]
}`,
  },
  {
    lang: "yaml",
    label: "YAML",
    code: `name: codebox
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    # This trailing comment is long on purpose to show indent-preserving wrap.
    steps:
      - run: bun test`,
  },
];

const MALFORMED = `function broken( {
  const s = "this string is never closed and the braces are all wrong {{{
  return arr.map(=>
const x =`;

export function App() {
  const [theme, setTheme] = useState<(typeof THEMES)[number]>("github-light");
  const [wrap, setWrap] = useState(true);
  const [hangingIndent, setHangingIndent] = useState(0);
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [width, setWidth] = useState(440);

  const dark = theme === "github-dark";

  return (
    <div className={dark ? "page page--dark" : "page"}>
      <header className="hero">
        <h1>
          code<span>box</span>
        </h1>
        <p className="tagline">
          Xcode-style React code blocks. Shiki highlighting,{" "}
          <strong>indent-aware soft wrapping</strong>, and it never chokes on
          malformed syntax.
        </p>
        <p className="install">
          <code>bun add @neongreen/codebox</code>
        </p>
        <a className="repo-link" href="https://github.com/neongreen/codebox">
          github.com/neongreen/codebox →
        </a>
      </header>

      <section className="controls">
        <label>
          Theme
          <select
            value={theme}
            onChange={(e) =>
              setTheme(e.target.value as (typeof THEMES)[number])
            }
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
          />
          Soft wrap
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showLineNumbers}
            onChange={(e) => setShowLineNumbers(e.target.checked)}
          />
          Line numbers
        </label>
        <label>
          Hanging indent: {hangingIndent}
          <input
            type="range"
            min={0}
            max={8}
            value={hangingIndent}
            onChange={(e) => setHangingIndent(Number(e.target.value))}
          />
        </label>
        <label>
          Width: {width}px
          <input
            type="range"
            min={220}
            max={760}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
      </section>

      <main>
        <section className="featured">
          <h2>The headline trick</h2>
          <p>
            Drag the <strong>width</strong> slider down. The long string literal
            and comments wrap, but every continuation line stays lined up under
            the code — indentation is never destroyed. Toggle{" "}
            <strong>soft wrap</strong> off to compare with horizontal scrolling.
          </p>
          <div className="featured-box" style={{ maxWidth: width }}>
            <CodeBox
              code={SAMPLES[0]!.code}
              lang="typescript"
              theme={theme}
              wrap={wrap}
              hangingIndent={hangingIndent}
              showLineNumbers={showLineNumbers}
            />
          </div>
        </section>

        <section>
          <h2>Every language</h2>
          <div className="grid">
            {SAMPLES.map((s) => (
              <figure key={s.lang} className="cell" style={{ maxWidth: width }}>
                <figcaption>{s.label}</figcaption>
                <CodeBox
                  code={s.code}
                  lang={s.lang}
                  theme={theme}
                  wrap={wrap}
                  hangingIndent={hangingIndent}
                  showLineNumbers={showLineNumbers}
                />
              </figure>
            ))}
          </div>
        </section>

        <section>
          <h2>Malformed syntax</h2>
          <p>
            Unterminated strings, mismatched braces, half-typed expressions.
            codebox highlights what it can and renders the rest verbatim — it
            never throws.
          </p>
          <div className="featured-box" style={{ maxWidth: width }}>
            <CodeBox
              code={MALFORMED}
              lang="typescript"
              theme={theme}
              wrap={wrap}
              hangingIndent={hangingIndent}
              showLineNumbers={showLineNumbers}
            />
          </div>
        </section>
      </main>

      <footer>
        <a href="https://github.com/neongreen/codebox">neongreen/codebox</a> ·
        MIT
      </footer>
    </div>
  );
}
