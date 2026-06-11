// cross-node-stream.test.ts — unit coverage for the cross-node live-tail SSE
// FAN-IN (CTL-885, BFF3). Every collaborator is injected so nothing reads a real
// hosts.json, contacts a real peer, or opens a real socket. These tests encode
// the three Gherkin scenarios directly:
//
//   1. A live tail follows the ticket to the node that owns it (multi-host →
//      remote fan-in keyed by host.name).
//   2. Per-host logs are never merged (the multiplexer fans in N per-host SSE
//      STREAMS keyed by host.name, never a shared/merged log).
//   3. Single-host fan-in is a pass-through (roster absent/len 1 → identity
//      no-op "local", zero added latency, no owner resolution, no remote hop).
import { describe, it, expect } from "bun:test";
import {
  readClusterRoster,
  isSingleHost,
  resolveTailRoute,
  resolvePeerBaseUrl,
  proxyRemoteTail,
} from "../lib/cross-node-stream.mjs";

const SESSION = "a1b2c3d4-0000-0000-0000-000000000000";

// A roster reader fake: returns whatever JSON the fake file holds. `read` throws
// when the file is "absent" so we cover the absent-roster single-host default.
function rosterDeps(fileContents: string | null) {
  return {
    env: { CATALYST_CONFIG_FILE: "/repo/.catalyst/config.json" } as NodeJS.ProcessEnv,
    read: ((_path: string) => {
      if (fileContents === null) throw new Error("ENOENT");
      return fileContents;
    }) as (path: string, encoding: "utf8") => string,
  };
}

describe("readClusterRoster — the single-host default tolerance", () => {
  it("absent hosts.json → [] (single-host default)", () => {
    expect(readClusterRoster(rosterDeps(null))).toEqual([]);
  });

  it("malformed JSON → [] (single-host default)", () => {
    expect(readClusterRoster(rosterDeps("not-json"))).toEqual([]);
  });

  it("non-array JSON → [] (single-host default)", () => {
    expect(readClusterRoster(rosterDeps('{"mini":true}'))).toEqual([]);
  });

  it("empty array → [] (single-host default)", () => {
    expect(readClusterRoster(rosterDeps("[]"))).toEqual([]);
  });

  it("a real multi-host roster is returned, filtering blanks", () => {
    expect(readClusterRoster(rosterDeps('["mini", "", "mac-studio"]'))).toEqual([
      "mini",
      "mac-studio",
    ]);
  });
});

describe("isSingleHost — the identity-no-op gate", () => {
  it("undefined / empty / length-1 rosters are single-host", () => {
    expect(isSingleHost(undefined as unknown as string[])).toBe(true);
    expect(isSingleHost([])).toBe(true);
    expect(isSingleHost(["mini"])).toBe(true);
  });

  it("a 2+ host roster is multi-host", () => {
    expect(isSingleHost(["mini", "mac-studio"])).toBe(false);
  });
});

describe("Scenario 3: Single-host fan-in is a pass-through (identity no-op)", () => {
  it("roster absent (empty) → { mode: local } WITHOUT resolving owner or base URL", () => {
    let ownerCalls = 0;
    let baseCalls = 0;
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: [],
      selfHost: "mini",
      ownerHostForSession: () => {
        ownerCalls += 1;
        return "mac-studio";
      },
      hostBaseUrl: () => {
        baseCalls += 1;
        return "http://mac-studio:7400";
      },
    });
    expect(route).toEqual({ mode: "local" });
    // Zero added latency: the no-op path NEVER touches owner resolution or the
    // cross-node transport seam.
    expect(ownerCalls).toBe(0);
    expect(baseCalls).toBe(0);
  });

  it("roster length 1 → { mode: local } (still the identity no-op)", () => {
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: ["mini"],
      selfHost: "mini",
      ownerHostForSession: () => "mac-studio",
      hostBaseUrl: () => "http://mac-studio:7400",
    });
    expect(route).toEqual({ mode: "local" });
  });
});

describe("Scenario 1: A live tail follows the ticket to the node that owns it", () => {
  it("multi-host, owner is a DIFFERENT node → remote fan-in keyed by host.name", () => {
    // Given ticket owned by mac-studio per its fence attachment, UI served by mini.
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: ["mini", "mac-studio"],
      selfHost: "mini",
      ownerHostForSession: (s) => {
        expect(s).toBe(SESSION); // the multiplexer keys the lookup on the session
        return "mac-studio";
      },
      hostBaseUrl: (h) => {
        expect(h).toBe("mac-studio"); // resolved BY host.name
        return "http://mac-studio:7400";
      },
    });
    expect(route).toEqual({
      mode: "remote",
      host: "mac-studio",
      url: `http://mac-studio:7400/api/ec-worker-stream/${SESSION}`,
    });
  });

  it("strips a trailing slash on the peer base URL before composing the path", () => {
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: ["mini", "mac-studio"],
      selfHost: "mini",
      ownerHostForSession: () => "mac-studio",
      hostBaseUrl: () => "http://mac-studio:7400/",
    });
    expect(route).toEqual({
      mode: "remote",
      host: "mac-studio",
      url: `http://mac-studio:7400/api/ec-worker-stream/${SESSION}`,
    });
  });

  it("multi-host but the owner IS this host → local tail (no self-fan-in hop)", () => {
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: ["mini", "mac-studio"],
      selfHost: "mini",
      ownerHostForSession: () => "mini",
      hostBaseUrl: () => "http://mini:7400",
    });
    expect(route).toEqual({ mode: "local" });
  });

  it("multi-host but the owner is UNKNOWN (no fence yet) → local tail (conservative)", () => {
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: ["mini", "mac-studio"],
      selfHost: "mini",
      ownerHostForSession: () => null,
      hostBaseUrl: () => "http://mac-studio:7400",
    });
    expect(route).toEqual({ mode: "local" });
  });

  it("multi-host, owner is a different node but its base URL is unresolvable → unroutable (404, never a wrong tail)", () => {
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: ["mini", "mac-studio"],
      selfHost: "mini",
      ownerHostForSession: () => "mac-studio",
      hostBaseUrl: () => null,
    });
    expect(route).toEqual({ mode: "unroutable", host: "mac-studio" });
  });
});

describe("Scenario 2: Per-host logs are never merged", () => {
  it("the route only ever yields a single owning host's per-host STREAM url — never a merged source", () => {
    // Three nodes, each ticket owned by exactly one; the fan-in resolves the ONE
    // owner's per-host stream, never an aggregate/merged endpoint.
    const owners: Record<string, string> = {
      "s-mini": "mini",
      "s-studio": "mac-studio",
      "s-laptop": "laptop",
    };
    const bases: Record<string, string> = {
      mini: "http://mini:7400",
      "mac-studio": "http://mac-studio:7400",
      laptop: "http://laptop:7400",
    };
    for (const [session, owner] of Object.entries(owners)) {
      const route = resolveTailRoute({
        sessionId: session,
        roster: ["mini", "mac-studio", "laptop"],
        selfHost: "mini",
        ownerHostForSession: (s) => owners[s],
        hostBaseUrl: (h) => bases[h],
      });
      if (owner === "mini") {
        expect(route).toEqual({ mode: "local" });
      } else {
        // exactly that owner's per-host stream — host.name in the resolution, no
        // shared/merged log endpoint anywhere.
        expect(route).toEqual({
          mode: "remote",
          host: owner,
          url: `${bases[owner]}/api/ec-worker-stream/${session}`,
        });
        if (route.mode === "remote") {
          expect(route.url).not.toContain("merged");
          expect(route.url).not.toContain("/api/board/stream");
          // keyed by THE owning host.name only
          expect(route.url.startsWith(bases[owner])).toBe(true);
        }
      }
    }
  });
});

describe("resolvePeerBaseUrl — the cross-node transport seam (single-node-descoped)", () => {
  it("no CATALYST_PEER_MONITORS env → null (the single-node MVP default)", () => {
    expect(resolvePeerBaseUrl("mac-studio", { env: {} as NodeJS.ProcessEnv })).toBeNull();
  });

  it("a configured map resolves the owning host's monitor base URL", () => {
    const env = {
      CATALYST_PEER_MONITORS: '{"mac-studio":"http://mac-studio:7400","laptop":"http://laptop:7400"}',
    } as NodeJS.ProcessEnv;
    expect(resolvePeerBaseUrl("mac-studio", { env })).toBe("http://mac-studio:7400");
    expect(resolvePeerBaseUrl("laptop", { env })).toBe("http://laptop:7400");
  });

  it("a host absent from the map → null (→ unroutable, never a wrong tail)", () => {
    const env = { CATALYST_PEER_MONITORS: '{"mac-studio":"http://mac-studio:7400"}' } as NodeJS.ProcessEnv;
    expect(resolvePeerBaseUrl("unknown-host", { env })).toBeNull();
  });

  it("malformed map JSON → null (degrades safely, never throws)", () => {
    const env = { CATALYST_PEER_MONITORS: "not-json" } as NodeJS.ProcessEnv;
    expect(resolvePeerBaseUrl("mac-studio", { env })).toBeNull();
  });

  it("empty / non-string host → null", () => {
    const env = { CATALYST_PEER_MONITORS: '{"mac-studio":"http://x"}' } as NodeJS.ProcessEnv;
    expect(resolvePeerBaseUrl("", { env })).toBeNull();
  });

  it("end-to-end: a configured peer makes resolveTailRoute route remote", () => {
    const env = { CATALYST_PEER_MONITORS: '{"mac-studio":"http://mac-studio:7400"}' } as NodeJS.ProcessEnv;
    const route = resolveTailRoute({
      sessionId: SESSION,
      roster: ["mini", "mac-studio"],
      selfHost: "mini",
      ownerHostForSession: () => "mac-studio",
      hostBaseUrl: (h) => resolvePeerBaseUrl(h, { env }),
    });
    expect(route).toEqual({
      mode: "remote",
      host: "mac-studio",
      url: `http://mac-studio:7400/api/ec-worker-stream/${SESSION}`,
    });
  });
});

describe("proxyRemoteTail — transparent SSE multiplex of the owning node's stream", () => {
  const PEER_URL = `http://mac-studio:7400/api/ec-worker-stream/${SESSION}`;

  function sseBody(frames: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
  }

  it("on a 2xx with a body, streams the peer's SSE frames straight through (no re-frame)", async () => {
    const frame = `event: stream-event\ndata: ${JSON.stringify({ ts: 1, type: "turn" })}\n\n`;
    let requestedUrl = "";
    let acceptHeader = "";
    const body = await proxyRemoteTail({
      url: PEER_URL,
      fetchImpl: ((url: string, init?: RequestInit) => {
        requestedUrl = url;
        acceptHeader = (init?.headers as Record<string, string>)?.Accept ?? "";
        return Promise.resolve(
          new Response(sseBody([frame]), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect(requestedUrl).toBe(PEER_URL);
    expect(acceptHeader).toBe("text/event-stream");
    expect(body).not.toBeNull();
    // The body is the upstream stream verbatim — read it and confirm the exact frame.
    const reader = body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(frame);
  });

  it("on a non-2xx, returns null so the route maps it to 502 (a down peer never wedges the client)", async () => {
    const body = await proxyRemoteTail({
      url: PEER_URL,
      fetchImpl: (() =>
        Promise.resolve(new Response("nope", { status: 503 }))) as unknown as typeof fetch,
    });
    expect(body).toBeNull();
  });

  it("on a network/abort failure, returns null (never throws, never a wrong tail)", async () => {
    const body = await proxyRemoteTail({
      url: PEER_URL,
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    expect(body).toBeNull();
  });

  it("forwards the AbortSignal so a client disconnect tears down the upstream subscription", async () => {
    const ctrl = new AbortController();
    let forwarded: AbortSignal | undefined;
    await proxyRemoteTail({
      url: PEER_URL,
      signal: ctrl.signal,
      fetchImpl: ((_url: string, init?: RequestInit) => {
        forwarded = init?.signal ?? undefined;
        return Promise.resolve(new Response(sseBody([]), { status: 200 }));
      }) as unknown as typeof fetch,
    });
    expect(forwarded).toBe(ctrl.signal);
  });
});
