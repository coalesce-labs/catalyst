// ticket-markdown.test.ts — units for the ticket DESCRIPTION markdown engine
// (CTL-974 client pass). Exercises the DOM-FREE seams: the pure markdown→HTML
// step (marked + hljs spans, inline-code chips, fail-open) and the ticket-ref
// pill regex/substitution. The browser-only DOM walk (linkifyTicketRefs) is not
// exercised here (bun has no DOMParser); its WHICH-node decision is structural
// and verified by the vite build + live UI. Run from ui:
//   cd ui && bun test src/lib/ticket-markdown.test.ts
import { describe, it, expect } from "bun:test";
import {
  markdownToRawHtml,
  isTicketRef,
  ticketRefHref,
  ticketRefRegex,
  replaceRefsInPlainText,
} from "@/lib/ticket-markdown";

describe("markdownToRawHtml — inline code chip", () => {
  it("wraps inline code in a <code> element (chip styled via .ticket-desc CSS)", () => {
    const html = markdownToRawHtml("use the `eligible-set.mjs` helper");
    expect(html).toContain("<code>eligible-set.mjs</code>");
    // inline code is NOT inside a <pre> (so the chip rule, not the block rule).
    expect(html).not.toContain("<pre>");
  });
});

describe("markdownToRawHtml — fenced code block → hljs spans", () => {
  it("emits a highlighted <pre><code class=hljs ...> with token spans", () => {
    const html = markdownToRawHtml(
      "```typescript\nconst x: number = 1; // c\n```",
    );
    expect(html).toContain("<pre>");
    expect(html).toContain("hljs language-typescript");
    // a keyword span and a comment span proves real highlighting ran.
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('class="hljs-comment"');
  });

  it("falls back to plaintext for an unregistered language (no throw)", () => {
    const html = markdownToRawHtml("```cobol\nDISPLAY 'HI'.\n```");
    expect(html).toContain("<pre>");
    // unregistered → plaintext highlight, still a code block, no crash.
    expect(html).toContain("language-cobol");
  });

  it("renders gfm features (bold, heading, list)", () => {
    const html = markdownToRawHtml("## Summary\n\n**bold** and a\n\n- item\n");
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>item</li>");
  });
});

describe("markdownToRawHtml — gherkin highlighting (CTL-996)", () => {
  it("emits hljs-keyword spans for Given/When/Then/Scenario/Feature keywords", () => {
    const html = markdownToRawHtml(
      "```gherkin\nFeature: x\nScenario: y\n  Given a\n  When b\n  Then c\n```",
    );
    expect(html).toContain("hljs language-gherkin");
    // the gherkin keywords are tagged .hljs-keyword (coloured purple by the
    // existing .ticket-desc .hljs-keyword CSS — no new CSS).
    expect(html).toContain('class="hljs-keyword"');
  });

  it("supports the 'feature' alias for gherkin", () => {
    const html = markdownToRawHtml(
      "```feature\nScenario: s\n  Then ok\n```",
    );
    expect(html).toContain("hljs language-feature");
    expect(html).toContain('class="hljs-keyword"');
  });

  it("an unregistered language still escapes the code (no crash, no spans)", () => {
    const html = markdownToRawHtml("```cobol\nDISPLAY '<x>'.\n```");
    expect(html).toContain("<pre>");
    // the angle brackets are escaped (not raw HTML) — proves the unregistered
    // path escapes rather than highlights.
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain('class="hljs-keyword"');
  });
});

describe("ticket-ref pill regex (pure seam)", () => {
  it("matches known team prefixes", () => {
    expect(isTicketRef("CTL-926")).toBe(true);
    expect(isTicketRef("ADV-12")).toBe(true);
    expect(isTicketRef("ADVA-3")).toBe(true);
    expect(isTicketRef("OTL-100")).toBe(true);
  });

  it("rejects non-ticket tokens (prevents false pills)", () => {
    expect(isTicketRef("HTTP-200")).toBe(false);
    expect(isTicketRef("ISO-8601")).toBe(false);
    expect(isTicketRef("CTL-")).toBe(false);
    expect(isTicketRef("CTL926")).toBe(false);
    expect(isTicketRef("xCTL-1")).toBe(false);
  });

  it("ticketRefHref links to the internal SPA route", () => {
    expect(ticketRefHref("CTL-838")).toBe("/ticket/CTL-838");
  });

  it("ticketRefRegex finds refs mid-sentence on word boundaries", () => {
    const re = ticketRefRegex();
    const found = "see CTL-838 and ADV-12, but not xCTL-1".match(re);
    expect(found).toEqual(["CTL-838", "ADV-12"]);
  });
});

describe("replaceRefsInPlainText — pill substitution on a safe text node", () => {
  it("turns a bare ref into a pill anchor to /ticket/<id>", () => {
    const out = replaceRefsInPlainText("blocked by CTL-926 now");
    expect(out).toBe(
      'blocked by <a class="ticket-ref-pill" href="/ticket/CTL-926">CTL-926</a> now',
    );
  });

  it("leaves non-ref text untouched", () => {
    expect(replaceRefsInPlainText("an HTTP-200 response")).toBe(
      "an HTTP-200 response",
    );
  });

  it("replaces multiple refs in one string", () => {
    const out = replaceRefsInPlainText("CTL-1 then CTL-2");
    expect(out).toContain('href="/ticket/CTL-1"');
    expect(out).toContain('href="/ticket/CTL-2"');
  });
});

describe("markdownToRawHtml — fail-open", () => {
  it("never throws on degenerate input (returns a string)", () => {
    // marked is permissive; assert the contract holds for odd inputs.
    expect(typeof markdownToRawHtml("")).toBe("string");
    expect(typeof markdownToRawHtml("```\nunterminated")).toBe("string");
  });
});
