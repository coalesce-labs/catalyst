// ticket-markdown.ts — the ONE place that configures `marked` for ticket
// DESCRIPTIONS (CTL-974 client pass). Mirrors lib/briefings.ts::renderBriefingHtml
// (already shipping `marked.parse → DOMPurify.sanitize`) and ADDS:
//   - syntax highlighting (highlight.js EMPTY core + a small registered subset),
//   - inline ticket-ref PILLS (CTL-838 → /ticket/CTL-838 SPA anchor).
//
// The detail route is lazy (board/detail-route is code-split), and this module is
// only imported by ticket-description.tsx (mounted on the ticket route), so the
// markdown engine + highlighter land in the detail chunk — never in home/board.
//
// SAFETY: every path runs DOMPurify.sanitize (repo convention). hljs output is
// class-only <span>s; pills are controlled internal anchors. No description
// reaches the DOM unsanitized.  Fail-open: any throw → an escaped <pre> of the
// raw markdown (honest, never a blank).

import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";

// Register ONLY the grammars we expect in ticket descriptions (empty `core`
// import → no 190-language default bundle). Aliases map to the same grammar.
(
  [
    ["typescript", typescript],
    ["tsx", typescript],
    ["javascript", javascript],
    ["jsx", javascript],
    ["json", json],
    ["bash", bash],
    ["sh", bash],
    ["shell", bash],
    ["diff", diff],
    ["python", python],
    ["py", python],
    ["yaml", yaml],
    ["yml", yaml],
  ] as const
).forEach(([name, lang]) => hljs.registerLanguage(name, lang));

const mdEngine = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      // Only highlight when the grammar is REGISTERED (we import an EMPTY core +
      // a small subset, so "plaintext"/yaml-less fences are unregistered). For an
      // unregistered language, return the escaped code unhighlighted — calling
      // hljs.highlight(..., {language:"plaintext"}) THROWS because plaintext is
      // not in the core bundle, which would fail-open the WHOLE description to a
      // raw <pre>. This keeps the fenced block, just without token colours.
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return escapeHtml(code);
    },
  }),
  { gfm: true, breaks: false },
);

// ── ticket-ref pills ──────────────────────────────────────────────────────────
// The prefix allow-list — only KNOWN team keys become pills, so "HTTP-200" or
// "ISO-8601" never falsely linkify. Driven by the same team-key shape the server
// fetcher's parseIdentifier accepts; extend here if a new team board appears.
const TICKET_REF_PREFIXES = ["CTL", "ADV", "ADVA", "OTL", "EVR", "SLI"] as const;

/** The ticket-ref matcher — a `\b(CTL|ADV|...)-\d+\b` global regex. Exported so
 *  the pure match behaviour is unit-tested without a DOM. A fresh instance per
 *  call avoids shared `lastIndex` state across the (stateful, /g) regex. */
export function ticketRefRegex(): RegExp {
  return new RegExp(`\\b(${TICKET_REF_PREFIXES.join("|")})-\\d+\\b`, "g");
}

/** True when `token` is a bare ticket reference (whole-string match). Pure +
 *  DOM-free → the unit seam for the pill regex. */
export function isTicketRef(token: string): boolean {
  return new RegExp(`^(${TICKET_REF_PREFIXES.join("|")})-\\d+$`).test(token);
}

/** The internal SPA href a ticket ref links to. */
export function ticketRefHref(ref: string): string {
  return `/ticket/${ref}`;
}

/** replaceRefsInPlainText — pure, DOM-free pill substitution for ONE plain-text
 *  string (the exact transform applied to each safe TEXT node). Exported as the
 *  unit seam: proves a ref becomes a pill anchor and non-refs are left alone,
 *  without needing a DOMParser. The DOM walk (linkifyTicketRefs) decides WHICH
 *  text nodes to run this on (skipping A/CODE/PRE), so code-block refs never
 *  reach this function. */
export function replaceRefsInPlainText(text: string): string {
  return text.replace(ticketRefRegex(), (ref) => {
    return `<a class="ticket-ref-pill" href="${ticketRefHref(ref)}">${ref}</a>`;
  });
}

/** escape for the fail-open <pre> branch (DOM-free; small + deterministic). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** linkifyTicketRefs — DOM-walk the sanitized HTML's TEXT nodes (skipping A/CODE/
 *  PRE ancestors) and replace bare ticket refs with `<a class="ticket-ref-pill">`.
 *  Runs POST-sanitize and on TEXT NODES ONLY, so it never touches code blocks,
 *  existing links, or the sanitizer's allow-list. Browser-only (uses DOMParser);
 *  in a non-DOM context it returns the input unchanged (the regex itself is unit-
 *  tested via isTicketRef/ticketRefRegex above). */
export function linkifyTicketRefs(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (!text.nodeValue) continue;
    // Skip text inside an anchor, inline code, or a code block.
    let skip = false;
    for (let el = text.parentElement; el; el = el.parentElement) {
      const tag = el.tagName;
      if (tag === "A" || tag === "CODE" || tag === "PRE") {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    if (ticketRefRegex().test(text.nodeValue)) targets.push(text);
  }

  for (const text of targets) {
    const source = text.nodeValue ?? "";
    const frag = doc.createDocumentFragment();
    let last = 0;
    const re = ticketRefRegex();
    for (let m = re.exec(source); m; m = re.exec(source)) {
      const ref = m[0];
      if (m.index > last) {
        frag.appendChild(doc.createTextNode(source.slice(last, m.index)));
      }
      const a = doc.createElement("a");
      a.className = "ticket-ref-pill";
      a.setAttribute("href", ticketRefHref(ref));
      a.textContent = ref;
      frag.appendChild(a);
      last = m.index + ref.length;
    }
    if (last < source.length) {
      frag.appendChild(doc.createTextNode(source.slice(last)));
    }
    text.parentNode?.replaceChild(frag, text);
  }

  return doc.body.innerHTML;
}

/** markdownToRawHtml — the PURE, DOM-free markdown→HTML step (marked + hljs
 *  syntax highlighting). This is the unit seam: it needs no DOMParser/window, so
 *  the inline-code-chip / fenced-block-hljs-span behaviour is testable without a
 *  DOM. It is NOT sanitized — never feed its output to the DOM directly; use
 *  renderTicketDescriptionHtml for that. Fail-open: any throw → an escaped <pre>. */
export function markdownToRawHtml(md: string): string {
  try {
    return mdEngine.parse(md) as string;
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

/** renderTicketDescriptionHtml — markdown → SANITIZED HTML with hljs spans +
 *  ticket-ref pills. The browser-facing composition: markdownToRawHtml →
 *  DOMPurify.sanitize → linkifyTicketRefs. Fail-open: any throw → an escaped
 *  <pre> of the raw markdown (never a blank, never unsanitized). */
export function renderTicketDescriptionHtml(md: string): string {
  try {
    const raw = markdownToRawHtml(md);
    // ADD_ATTR: hljs needs `class`; marked link output carries `target`/`rel`.
    const safe = DOMPurify.sanitize(raw, { ADD_ATTR: ["target", "rel", "class"] });
    return linkifyTicketRefs(safe);
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}
