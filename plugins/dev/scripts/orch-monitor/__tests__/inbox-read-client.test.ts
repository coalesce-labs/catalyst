// inbox-read-client.test.ts — units for the HOME reading-pane READ path
// (CTL-1042): the per-item AI summary fetch, the research/plan artifact-list
// fetch, and the deep-dive pill href. The read-path mirror of
// respond-client.test.ts — the module is React-/DOM-free so `bun test` units it
// directly with an injected fetch, the same way the write path is tested. The
// surface wiring (the hooks reach the network ONLY through this client) is
// guarded by static source analysis in home-surface.test.ts's no-fetch invariant.
import { describe, it, expect } from "bun:test";
import {
  artifactHref,
  fetchArtifacts,
  fetchInboxSummary,
} from "../ui/src/board/inbox-read-client";

/** Wrap an impl(url, init) → Response as a typed fetch. */
function mockFetch(impl: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((input: string | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch;
}

/** A throwing fetch — simulates a network failure (offline / DNS). */
const boomFetch: typeof fetch = ((_input: string | URL, _init?: RequestInit) =>
  Promise.reject(new Error("network down"))) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchInboxSummary — per-item AI summary (CTL-1042)", () => {
  it("GETs the summary endpoint and threads ?phase= when present", async () => {
    let seen = "";
    const fetchImpl = mockFetch((url) => {
      seen = url;
      return jsonResponse({ enabled: true, summary: "s", ask: "a" });
    });
    const out = await fetchInboxSummary("CTL-1", "verify", { fetchImpl });
    expect(seen).toBe("/api/inbox/CTL-1/summary?phase=verify");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.response.enabled).toBe(true);
      expect(out.response.ask).toBe("a");
    }
  });

  it("omits the ?phase= query when no phase is given", async () => {
    let seen = "";
    const fetchImpl = mockFetch((url) => {
      seen = url;
      return jsonResponse({ enabled: true });
    });
    await fetchInboxSummary("CTL-2", undefined, { fetchImpl });
    expect(seen).toBe("/api/inbox/CTL-2/summary");
  });

  it("fails soft to ok:false on a non-ok status (pane keeps raw content)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: "boom" }, 500));
    const out = await fetchInboxSummary("CTL-3", undefined, { fetchImpl });
    expect(out.ok).toBe(false);
  });

  it("fails soft to ok:false on a network throw (never a throw of its own)", async () => {
    const out = await fetchInboxSummary("CTL-4", undefined, { fetchImpl: boomFetch });
    expect(out.ok).toBe(false);
  });
});

describe("fetchArtifacts — research/plan deep-dive list (CTL-1042)", () => {
  it("GETs the list route and returns the artifacts array", async () => {
    let seen = "";
    const fetchImpl = mockFetch((url) => {
      seen = url;
      return jsonResponse({
        ticket: "CTL-5",
        artifacts: [{ kind: "research", path: "p", peek: null }],
        crossNodeCaveat: "note",
      });
    });
    const out = await fetchArtifacts("CTL-5", { fetchImpl });
    expect(seen).toBe("/api/ticket-artifacts/CTL-5");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.artifacts).toHaveLength(1);
      expect(out.artifacts[0].kind).toBe("research");
    }
  });

  it("tolerates a response with no artifacts field (empty list, ok:true)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ ticket: "CTL-6" }));
    const out = await fetchArtifacts("CTL-6", { fetchImpl });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.artifacts).toEqual([]);
  });

  it("fails soft to ok:false on a non-ok status (no pills render)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({}, 404));
    const out = await fetchArtifacts("CTL-7", { fetchImpl });
    expect(out.ok).toBe(false);
  });

  it("fails soft to ok:false on a network throw", async () => {
    const out = await fetchArtifacts("CTL-8", { fetchImpl: boomFetch });
    expect(out.ok).toBe(false);
  });
});

describe("artifactHref — deep-dive pill URL shape (CTL-1042)", () => {
  // Locks the by-kind content route the pill opens — the exact path the server's
  // /^\/api\/ticket-artifacts\/([^/]+)\/([^/]+)$/ handler serves markdown from.
  // The broken-link regression (finding #2) was the pill pointing at a route
  // that did not exist; this is the single source of truth for that URL.
  it("builds the two-segment by-kind content path", () => {
    expect(artifactHref("CTL-1042", "research")).toBe(
      "/api/ticket-artifacts/CTL-1042/research",
    );
    expect(artifactHref("CTL-1042", "plan")).toBe(
      "/api/ticket-artifacts/CTL-1042/plan",
    );
  });

  it("encodes the ticket segment", () => {
    expect(artifactHref("a/b", "plan")).toBe("/api/ticket-artifacts/a%2Fb/plan");
  });
});
