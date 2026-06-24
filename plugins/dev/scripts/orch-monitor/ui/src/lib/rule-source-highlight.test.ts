// rule-source-highlight.test.ts — CTL-1328
import { describe, it, expect } from "bun:test";
import { highlightRuleSource } from "./rule-source-highlight";

describe("highlightRuleSource", () => {
  it("returns empty string for null/empty", () => {
    expect(highlightRuleSource(null)).toBe("");
    expect(highlightRuleSource("")).toBe("");
  });

  it("HTML-escapes SQL comparison operators (no raw < or >)", () => {
    // `l.state <> want.k` must not emit a literal `<>` that breaks the markup.
    const html = highlightRuleSource("WHERE l.state <> want.k AND a < b");
    expect(html).toContain("&lt;&gt;");
    expect(html).toContain("&lt;");
    // the only `<` chars are inside our own <span> tags
    expect(html).not.toMatch(/<(?!\/?span)/);
  });

  it("wraps keywords (SQL + .dl) in hljs-keyword", () => {
    const html = highlightRuleSource("SELECT x FROM t WHERE not done");
    expect(html).toContain('<span class="hljs-keyword">SELECT</span>');
    expect(html).toContain('<span class="hljs-keyword">FROM</span>');
    expect(html).toContain('<span class="hljs-keyword">not</span>');
  });

  it("wraps the `:-` clause operator as a keyword", () => {
    expect(highlightRuleSource("foo :-\n bar.")).toContain(
      '<span class="hljs-keyword">:-</span>',
    );
  });

  it("wraps single-quoted strings in hljs-string", () => {
    // esc() escapes &, <, > (not apostrophes), so the literal stays intact.
    expect(highlightRuleSource("name = 'never-started'")).toContain(
      "<span class=\"hljs-string\">'never-started'</span>",
    );
  });

  it("wraps numbers and built-ins distinctly", () => {
    const html = highlightRuleSource("json_object('cap', 3)");
    expect(html).toContain('<span class="hljs-built_in">json_object</span>');
    expect(html).toContain('<span class="hljs-number">3</span>');
  });

  it("leaves table/identifier names unstyled (plain escaped text)", () => {
    const html = highlightRuleSource("obs_signal s");
    expect(html).toContain("obs_signal");
    expect(html).not.toContain('<span class="hljs-keyword">obs_signal');
  });

  it("highlights an `--` line comment", () => {
    expect(highlightRuleSource("-- base edge\nSELECT 1")).toContain(
      '<span class="hljs-comment">-- base edge</span>',
    );
  });
});
