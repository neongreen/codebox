import { describe, expect, test } from "bun:test";
import { highlightToLines } from "../src/highlight";
import { reflowToString } from "../src/reflow";

/**
 * Property-based protection for the whole reflow engine: a broad corpus of
 * real-world single lines, each reflowed at many widths. Regardless of how it
 * chooses to break, reflow must always
 *   (1) never throw,
 *   (2) relocate *only* whitespace — every non-space character preserved in
 *       order, and
 *   (3) at a very large width, return the line untouched.
 * These hold for well-formed and malformed input alike.
 */
const CORPUS: { lang: "typescript" | "tsx"; lines: string[] }[] = [
  {
    lang: "typescript",
    lines: [
      "const ok = a && b && c && d && e && f && g;",
      "const v = aaa + bbb * ccc - ddd / eee + fff;",
      "const cls = isActive ? 'btn-on' : 'btn-off';",
      "const r = cond ? a : b ? c : d ? e : f;",
      "if (user && user.profile && user.profile.ok && user.active) run();",
      "const m = items.filter(ok).map((x) => x.id).slice(0, 10);",
      "this.result = source.filter(ok).map(id).reduce(sum, 0);",
      "rows.map((r) => ({ id: r.id, name: r.name, ok: r.ok }));",
      "items.forEach((item) => { process(item); log(item.id); });",
      "const total = items.reduce((acc, x) => acc + x.value, 0);",
      "const cfg = configure({ alpha: 1, beta: 2, gamma: 3, delta: 4 });",
      "setTimeout(() => { doSomething(); doMore(); }, 1000);",
      "const m2 = new Map<string, number>([['a', 1], ['b', 2]]);",
      "function f<TKey, TValue, TExtra>(a: TKey, b: TValue): TExtra {}",
      "const s = useState<{ count: number; name: string }>(initial);",
      "const url = base + '/api/' + version + '/users/' + userId;",
      "type Status = 'idle' | 'loading' | 'success' | 'error';",
      "export const value = computeSomething(alpha, beta, gamma, delta);",
      // template literals: interpolation contents must stay inert (no break at
      // the `+`/`?:` inside `${…}`) — they carry a string scope.
      "const u = `result: ${a + b + c} and ${cond ? yes : no} end`;",
      "log(`a ${x.y.z} b ${count} c`, secondArgument, thirdArgument);",
      "const x = veryLongName || anotherLongName || thirdFallbackValue;",
      "import { alpha, beta, gamma, delta, epsilon } from './module';",
      // malformed / partial
      "foo(a && b && c",
      "a ? b",
      "const x = ",
      "a + b) * (c",
      "obj?.prop ?? fallback ?? other",
    ],
  },
  {
    lang: "tsx",
    lines: [
      "const el = <Button onClick={go} disabled={busy}>Save {label}</Button>;",
      "const c = ok ? <Yes label={l} /> : <No reason={r} />;",
      "const x = <Icon name=\"star\" size={16} className=\"big\" />;",
      "return <List><Item id={1} /><Item id={2} /><Item id={3} /></List>;",
      "const w = <div className=\"card\"><h1>{title}</h1><p>{body}</p></div>;",
      "<Form onSubmit={save}><Field name=\"a\" />{footer}</Form>",
    ],
  },
];

const WIDTHS = [4, 6, 8, 10, 14, 18, 24, 32, 48, 80, 200, 1000];

describe("reflow corpus: invariants across many widths", () => {
  for (const { lang, lines } of CORPUS) {
    for (const code of lines) {
      test(`[${lang}] ${code}`, async () => {
        const data = await highlightToLines(code, { lang });
        const tokens = data.lines[0]!.tokens;
        const noSpace = code.replace(/\s+/g, "");
        for (const w of WIDTHS) {
          let out!: string;
          expect(() => {
            out = reflowToString(tokens, w);
          }).not.toThrow();
          // (2) only whitespace was relocated
          expect(out.replace(/\s+/g, "")).toBe(noSpace);
          // (3) huge width => untouched
          if (w >= 1000) expect(out).toBe(code);
        }
      });
    }
  }
});
