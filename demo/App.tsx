import { useState, type CSSProperties } from "react";
import { CodeBox } from "../src/index";

const THEMES = ["github-light", "github-dark"] as const;

const COMMENT_STYLES: Record<string, CSSProperties | undefined> = {
  default: undefined,
  "muted italic": { fontStyle: "italic", opacity: 0.6 },
  highlighted: {
    background: "rgba(255, 213, 0, 0.18)",
    borderRadius: "3px",
    padding: "0 2px",
  },
  "red bold": { color: "#d1242f", fontWeight: 600 },
};

const FEATURED = `interface User {
  id: number;
  name: string;
}

// This is a long explanatory comment that will wrap when the box is narrow, and
// when it does, the comment marker is repeated at the start of every line so it
// keeps reading like a comment instead of dissolving into the indentation.
export function greet(user: User): string {
  const message = "Hello there, " + user.name + "! Welcome back. There is a lot of new stuff waiting for you to discover today, and we genuinely hope you enjoy all of it.";
  return computeGreeting(message, user.id, { uppercase: false, exclaim: true, repeat: 2, locale: "en-US" });
}`;

const SAMPLES: { lang: string; label: string; code: string }[] = [
  {
    lang: "typescript",
    label: "TypeScript",
    code: FEATURED,
  },
  {
    lang: "javascript",
    label: "JavaScript",
    code: `const numbers = [1, 2, 3, 4, 5];

// reduce the doubled odds down to a single delightful number
const doubled = numbers.filter((n) => n % 2 === 1).map((n) => n * 2).reduce((acc, n) => acc + n, 0);

console.log(\`The sum of the doubled odds is \${doubled}, which is honestly a delightful little number to end on.\`);`,
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
  /* A comment long enough to wrap, kept aligned under its marker rather than sprawling back to the left margin like a normal word-wrap would do. */
  font-feature-settings: "liga" 0;
}`,
  },
  {
    lang: "json",
    label: "JSON",
    code: `{
  "name": "@neongreen/codebox",
  "description": "A fairly long description value that wraps onto multiple visual lines while staying tucked under the opening quote instead of unindenting.",
  "keywords": ["react", "shiki", "code", "syntax", "wrapping", "indentation"]
}`,
  },
  {
    lang: "yaml",
    label: "YAML",
    code: `name: codebox
jobs:
  test:
    runs-on: ubuntu-latest
    # This trailing comment is long on purpose to show the indent-preserving wrap and repeated marker behaviour in YAML too.
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
  const [proseStrings, setProseStrings] = useState(true);
  const [repeatCommentMarker, setRepeatCommentMarker] = useState(true);
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [commentStyle, setCommentStyle] = useState("default");
  const [hangingIndent, setHangingIndent] = useState(0);
  const [width, setWidth] = useState(440);

  const dark = theme === "github-dark";

  const shared = {
    theme,
    wrap,
    proseStrings,
    repeatCommentMarker,
    showLineNumbers,
    hangingIndent,
    tokenStyles: { comment: COMMENT_STYLES[commentStyle] },
  };

  return (
    <div className={dark ? "page page--dark" : "page"}>
      <header className="hero">
        <h1>
          code<span>box</span>
        </h1>
        <p className="tagline">
          Xcode-style React code blocks. Shiki highlighting,{" "}
          <strong>structure-aware soft wrapping</strong>, proportional string
          bodies, repeated comment markers — and it never chokes on malformed
          syntax.
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
            checked={proseStrings}
            onChange={(e) => setProseStrings(e.target.checked)}
          />
          Prose strings
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={repeatCommentMarker}
            onChange={(e) => setRepeatCommentMarker(e.target.checked)}
          />
          Repeat comment marker
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
          Comment style
          <select
            value={commentStyle}
            onChange={(e) => setCommentStyle(e.target.value)}
          >
            {Object.keys(COMMENT_STYLES).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
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
          <h2>Everything at once</h2>
          <p>
            Drag <strong>width</strong> down. The string body wraps as
            proportional prose under the opening quote, the comment repeats its{" "}
            <code>//</code> marker per line, and the <code>computeGreeting(…)</code>{" "}
            call keeps its arguments aligned under the first one. Toggle anything
            above to compare.
          </p>
          <div className="featured-box" style={{ maxWidth: width }}>
            <CodeBox code={FEATURED} lang="typescript" {...shared} />
          </div>
        </section>

        <section>
          <h2>Indentation that survives word-wrap, everywhere</h2>
          <p>
            Not just leading whitespace — function arguments, array and object
            literals, string bodies, and comments all keep their alignment when
            a long line wraps.
          </p>
          <div className="featured-box" style={{ maxWidth: width }}>
            <CodeBox
              code={`const result = computeSomething(firstArgument, secondArgument, thirdArgument, fourthArgument, fifthArgument);
const config = { enabled: true, retries: 3, timeout: 30000, backoff: "exponential", labels: ["a", "b", "c"] };`}
              lang="typescript"
              {...shared}
            />
          </div>
        </section>

        <section>
          <h2>Every language</h2>
          <div className="grid">
            {SAMPLES.map((s) => (
              <figure key={s.lang} className="cell" style={{ maxWidth: width }}>
                <figcaption>{s.label}</figcaption>
                <CodeBox code={s.code} lang={s.lang} {...shared} />
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
            <CodeBox code={MALFORMED} lang="typescript" {...shared} />
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
