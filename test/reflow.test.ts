import { describe, expect, test } from "bun:test";
import { highlightToLines } from "../src/highlight";
import { reflowLine, reflowToString } from "../src/reflow";
import type { CodeToken } from "../src/types";

/** Build code-kind tokens from a raw string (one token per call is fine; the
 *  reflow works at the character level and re-coalesces). */
async function toks(code: string): Promise<CodeToken[]> {
  const data = await highlightToLines(code, { lang: "typescript" });
  return data.lines[0]!.tokens;
}

/** Same, but with the TSX grammar so JSX gets its proper token roles. */
async function tsxToks(code: string): Promise<CodeToken[]> {
  const data = await highlightToLines(code, { lang: "tsx" });
  return data.lines[0]!.tokens;
}

describe("reflowLine: chain reformatting", () => {
  test("a line with no operators or brackets is left untouched", async () => {
    const t = await toks("const value = singleLongIdentifierWithNoBreakPoints;");
    const r = reflowLine(t, 10);
    expect(r.reflowed).toBe(false);
    expect(r.lines).toHaveLength(1);
  });

  test("a standalone call breaks its args one per line (no mid-identifier wrap)", async () => {
    const t = await toks("const r = compute(alpha, beta, gamma, delta);");
    expect(reflowToString(t, 20)).toBe(
      [
        "const r = compute(",
        "  alpha,",
        "  beta,",
        "  gamma,",
        "  delta",
        ");",
      ].join("\n"),
    );
  });

  test("an array literal breaks one element per line when it overflows", async () => {
    const t = await toks("const xs = [one, two, three, four, five];");
    expect(reflowToString(t, 14)).toBe(
      ["const xs = [", "  one,", "  two,", "  three,", "  four,", "  five", "];"].join(
        "\n",
      ),
    );
  });

  test("property accesses split by an operator break by precedence, not as a chain", async () => {
    // `.` accesses on different receivers, separated by `&&`/`>` — must break at
    // the operators (one operand per line), not be reformatted as one member
    // chain. Each `b.active`-style property access stays intact.
    const t = await toks(
      "const ok = a.length > 0 && b.active && c.ready && d.enabled;",
    );
    expect(reflowToString(t, 18)).toBe(
      [
        "const ok =",
        "  a.length > 0 &&",
        "  b.active &&",
        "  c.ready &&",
        "  d.enabled;",
      ].join("\n"),
    );
  });

  test("an assignment prefix stays on the first line; only the chain breaks", async () => {
    const t = await toks("this.result = source.filter(ok).map(id).slice(0);");
    expect(reflowToString(t, 24)).toBe(
      [
        "this.result = source",
        "  .filter(ok)",
        "  .map(id)",
        "  .slice(0);",
      ].join("\n"),
    );
  });

  test("a chain that fits stays on one line", async () => {
    const t = await toks("items.filter(ok).map(id).slice(0, 10)");
    expect(reflowToString(t, 200)).toBe("items.filter(ok).map(id).slice(0, 10)");
  });

  test("a chain that overflows breaks one call per line under the head", async () => {
    const t = await toks("items.filter(ok).map(id).slice(0, 10)");
    // Width forces the chain to break, but each call still fits on its line.
    expect(reflowToString(t, 20)).toBe(
      ["items", "  .filter(ok)", "  .map(id)", "  .slice(0, 10)"].join("\n"),
    );
  });

  test("leading indentation is preserved and links indent past it", async () => {
    const t = await toks("    items.filter(ok).map(id).slice(0, 10)");
    expect(reflowToString(t, 20)).toBe(
      [
        "    items",
        "      .filter(ok)",
        "      .map(id)",
        "      .slice(0, 10)",
      ].join("\n"),
    );
  });

  test("nested: only the call that is still too wide breaks its arguments", async () => {
    const t = await toks(
      "data.filter(alpha, beta, gamma, delta).map(id).slice(0)",
    );
    // The chain breaks; .filter(...) is wider than the others, so only it
    // descends and breaks its argument list — .map / .slice stay intact.
    const s = reflowToString(t, 24);
    expect(s).toBe(
      [
        "data",
        "  .filter(",
        "    alpha,",
        "    beta,",
        "    gamma,",
        "    delta",
        "  )",
        "  .map(id)",
        "  .slice(0)",
      ].join("\n"),
    );
  });

  test("a small group doesn't break just because later content overflows", async () => {
    // Regression: `(r)` must stay on one line even though the arrow body that
    // follows it overflows (Wadler `fits` coupling bug).
    const t = await toks("rows.map((r) => ({ id: r.id, name: r.name, ok: r.ok }))");
    const lines = reflowToString(t, 22).split("\n");
    // `(r)` is intact on some line; no line is a lone `(` or `r`.
    expect(lines.some((l) => l.includes("(r)"))).toBe(true);
    expect(lines.some((l) => l.trim() === "r")).toBe(false);
  });

  test("never alters non-space characters (only relocates whitespace)", async () => {
    const code = "obj.aaaa(1, 2).bbbb(3, 4).cccc(5, 6)";
    const t = await toks(code);
    for (const width of [5, 12, 20, 80, 500]) {
      const flattened = reflowToString(t, width).replace(/\s+/g, "");
      expect(flattened).toBe(code.replace(/\s+/g, ""));
    }
  });

  test("custom indent unit", async () => {
    const t = await toks("a.bbb().ccc().ddd()");
    expect(reflowToString(t, 8, 4)).toBe(
      ["a", "    .bbb()", "    .ccc()", "    .ddd()"].join("\n"),
    );
  });
});

describe("reflowLine: argument hugging", () => {
  test("a sole arrow returning an object hugs both brackets", async () => {
    const t = await toks("rows.map((r) => ({ id: r.id, name: r.name, ok: r.ok }))");
    expect(reflowToString(t, 22)).toBe(
      [
        "rows.map((r) => ({",
        "  id: r.id,",
        "  name: r.name,",
        "  ok: r.ok",
        "}))",
      ].join("\n"),
    );
  });

  test("a sole object argument hugs the call bracket", async () => {
    const t = await toks("configure({ alpha: 1, beta: 2, gamma: 3, delta: 4 })");
    expect(reflowToString(t, 20)).toBe(
      [
        "configure({",
        "  alpha: 1,",
        "  beta: 2,",
        "  gamma: 3,",
        "  delta: 4",
        "})",
      ].join("\n"),
    );
  });

  test("a top-level arrow returning an object hugs (param list stays flat)", async () => {
    const t = await toks("const f = (a, b, c) => ({ sum: a + b + c, product: a * b });");
    expect(reflowToString(t, 24)).toBe(
      [
        "const f = (a, b, c) => ({",
        "  sum: a + b + c,",
        "  product: a * b",
        "});",
      ].join("\n"),
    );
  });

  test("a hugged block body breaks one statement per line on `;`", async () => {
    const t = await toks("items.forEach((item) => { process(item); log(item.id); })");
    expect(reflowToString(t, 24)).toBe(
      [
        "items.forEach((item) => {",
        "  process(item);",
        "  log(item.id);",
        "})",
      ].join("\n"),
    );
  });

  test("no hug when the callback is not the sole argument; header stays intact", async () => {
    // `() => {…}` is one of two args, so the call breaks per-argument and the
    // arrow header must NOT be left dangling as `() =>` on the opening line.
    const t = await toks("setTimeout(() => { doSomething(); doMore(); }, 1000)");
    expect(reflowToString(t, 24)).toBe(
      [
        "setTimeout(",
        "  () => {",
        "    doSomething();",
        "    doMore();",
        "  },",
        "  1000",
        ")",
      ].join("\n"),
    );
  });

  test("hugging still preserves every non-space character", async () => {
    const code = "rows.map((r) => ({ id: r.id, name: r.name, ok: r.ok }))";
    const t = await toks(code);
    for (const width of [5, 10, 18, 22, 40, 500]) {
      const flattened = reflowToString(t, width).replace(/\s+/g, "");
      expect(flattened).toBe(code.replace(/\s+/g, ""));
    }
  });
});

describe("reflowLine: precedence-aware expression breaking", () => {
  test("a logical chain breaks one operand per line under the =", async () => {
    const t = await toks("const ok = aa && bb && cc && dd && ee;");
    expect(reflowToString(t, 16)).toBe(
      ["const ok =", "  aa &&", "  bb &&", "  cc &&", "  dd &&", "  ee;"].join("\n"),
    );
  });

  test("multiplicative binds tighter than additive (only + breaks)", async () => {
    const t = await toks("const v = aaa + bbb * ccc + ddd * eee;");
    expect(reflowToString(t, 16)).toBe(
      ["const v =", "  aaa +", "  bbb * ccc +", "  ddd * eee;"].join("\n"),
    );
  });

  test("a ternary keeps its condition on the = line and stacks ? / :", async () => {
    const t = await toks("const cls = isActive ? 'on-state' : 'off-state';");
    expect(reflowToString(t, 22)).toBe(
      ["const cls = isActive", "  ? 'on-state'", "  : 'off-state';"].join("\n"),
    );
  });

  test("nested ternaries stair-step", async () => {
    const t = await toks("const r = cond ? a : b ? c : d;");
    expect(reflowToString(t, 12)).toBe(
      ["const r = cond", "  ? a", "  : b", "    ? c", "    : d;"].join("\n"),
    );
  });

  test("an if-condition breaks at && inside the parens, operands aligned", async () => {
    const t = await toks("if (alpha && beta && gamma && delta) run();");
    expect(reflowToString(t, 16)).toBe(
      ["if (", "  alpha &&", "  beta &&", "  gamma &&", "  delta", ") run();"].join(
        "\n",
      ),
    );
  });

  test("operators inside call arguments break per argument then per operator", async () => {
    const t = await toks("call(aa && bb, cc || dd, ee ? ff : gg);");
    expect(reflowToString(t, 14)).toBe(
      ["call(", "  aa && bb,", "  cc || dd,", "  ee ? ff : gg", ");"].join("\n"),
    );
  });

  test("precedence: ternary is the outer split, && lives in the condition", async () => {
    const t = await toks("const m = ready && set ? doIt(x) : skip(y);");
    expect(reflowToString(t, 22)).toBe(
      ["const m = ready && set", "  ? doIt(x)", "  : skip(y);"].join("\n"),
    );
  });

  test("a generic `<` is a breakable type-arg group, never a comparison", async () => {
    const t = await toks("const s = make<string, number>(seed);");
    // Wide: stays inline. The `<…>` is type punctuation, not two comparisons.
    expect(reflowToString(t, 80)).toBe("const s = make<string, number>(seed);");
    // Narrow: the type-argument list breaks like a call's arguments would —
    // one per line — rather than being split as `<` / `>` operators.
    expect(reflowToString(t, 16)).toBe(
      ["const s = make<", "  string,", "  number", ">(seed);"].join("\n"),
    );
  });

  test("a type-argument list breaks; a call that still fits stays inline", async () => {
    const t = await toks("useQuery<ResponseType, ErrorType>(key, fetcher);");
    expect(reflowToString(t, 20)).toBe(
      ["useQuery<", "  ResponseType,", "  ErrorType", ">(key, fetcher);"].join("\n"),
    );
  });

  test("comparison `<`/`>` still break as operators, not type args", async () => {
    const t = await toks("const ok = aa < bb && cc > dd;");
    expect(reflowToString(t, 12)).toBe(
      ["const ok =", "  aa < bb &&", "  cc > dd;"].join("\n"),
    );
  });

  test("never alters non-space characters across operator/ternary breaks", async () => {
    const code = "const z = a && b ? c + d * e : fn(g, h) || i;";
    const t = await toks(code);
    for (const width of [6, 10, 14, 20, 30, 80, 500]) {
      expect(reflowToString(t, width).replace(/\s+/g, "")).toBe(
        code.replace(/\s+/g, ""),
      );
    }
  });
});

describe("reflowLine: JSX", () => {
  test("attributes break one per line; > and close tag dedent, children indent", async () => {
    const t = await tsxToks(
      'const el = <Button onClick={go} disabled={busy}>Save</Button>;',
    );
    expect(reflowToString(t, 24)).toBe(
      [
        "const el = <Button",
        "  onClick={go}",
        "  disabled={busy}",
        ">",
        "  Save",
        "</Button>;",
      ].join("\n"),
    );
  });

  test("a self-closing tag keeps its `/>` and the space before it", async () => {
    const t = await tsxToks('const x = <Icon name="star" size={16} />;');
    expect(reflowToString(t, 20)).toBe(
      ["const x = <Icon", '  name="star"', "  size={16}", "/>;"].join("\n"),
    );
  });

  test("element children stack one per line; a tag with no attributes stays intact", async () => {
    const t = await tsxToks("<List><Item id={1} /><Item id={2} /></List>");
    expect(reflowToString(t, 18)).toBe(
      ["<List>", "  <Item id={1} />", "  <Item id={2} />", "</List>"].join("\n"),
    );
  });

  test("text and {expr} children stay inline together", async () => {
    const t = await tsxToks("<span>Hello {name} now</span>");
    expect(reflowToString(t, 18)).toBe(
      ["<span>", "  Hello {name} now", "</span>"].join("\n"),
    );
  });

  test("a ternary with JSX branches breaks as a ternary, branches intact", async () => {
    const t = await tsxToks("const c = ok ? <Yes label={l} /> : <No reason={r} />;");
    expect(reflowToString(t, 22)).toBe(
      ["const c = ok", "  ? <Yes label={l} />", "  : <No reason={r} />;"].join("\n"),
    );
  });

  test("never alters non-space characters across JSX breaks", async () => {
    const code =
      '<Form onSubmit={save}><Field name="a" /><Field name="b" />{footer}</Form>';
    const t = await tsxToks(code);
    for (const width of [8, 14, 20, 30, 60, 500]) {
      expect(reflowToString(t, width).replace(/\s+/g, "")).toBe(
        code.replace(/\s+/g, ""),
      );
    }
  });
});
