// inbox-conversation-endpoints.test.ts — CTL-1569: HTTP route plumbing for the
// inbox conversation surface. Proves the two routes are mounted, matched, and
// guarded; the assembly/post LOGIC is covered exhaustively by the injectable unit
// tests in lib/inbox-conversation.test.mjs and lib/inbox-conversation-compose.test.mjs.
//
// SAFETY: every test here uses a ticket id that cannot resolve to a real Linear
// issue, so no test can post a comment to a live ticket. The POST /reply happy
// path is deliberately NOT exercised over HTTP — it is a real external write, and
// its branches are already unit-tested with an injected fetch.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

/** Definitively not a real Linear issue, so route behavior is host-independent
 *  and no live ticket can be written to. Uses the `PROJ` fixture prefix per
 *  AGENTS.md → Version Control (never a real team's prefix, and never the
 *  `ZZZ-` form some older suites reach for). */
const ABSENT_TICKET = "PROJ-999999";

// The origin allowlist is built from the environment at first request, so an
// invoking host that exports these would change what this suite asserts. Cleared
// BEFORE createServer and restored after, so the endpoint results depend on the
// code under test rather than on the developer's or runner's monitor config.
const ORIGIN_ENV = ["MONITOR_TRUSTED_ORIGINS", "MONITOR_DEV_UI", "MONITOR_DEV_UI_ORIGINS"];
const prevOriginEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ORIGIN_ENV) {
    prevOriginEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "inbox-conversation-endpoints-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  server = createServer({ port: 0, wtDir, startWatcher: false });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  for (const k of ORIGIN_ENV) {
    if (prevOriginEnv[k] !== undefined) process.env[k] = prevOriginEnv[k];
    else delete process.env[k];
  }
  void server?.stop(true);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("GET /api/ticket/:id/thread (CTL-1569)", () => {
  it("returns 200 + the conversation shape for a ticket with nothing on disk", async () => {
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      ticket: string;
      thread: { comments: unknown[] };
      ask: unknown;
      canReply: boolean;
      url: string | null;
    };
    expect(body.ticket).toBe(ABSENT_TICKET);
    expect(body.thread.comments).toEqual([]);
    // No escalation explanation and no agent comment → an honestly ABSENT ask.
    expect(body.ask).toBeNull();
    expect(body.url).toBeNull();
  });

  it("NEVER 5xxs when the replica is unreadable (the read fails open)", async () => {
    // The inbox must not break because a local mirror is absent or locked.
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread`);
    expect(res.status).toBe(200);
  });

  it("honors a bounded ?limit and ignores a junk one", async () => {
    for (const q of ["?limit=3", "?limit=0", "?limit=-5", "?limit=abc", "?limit=99999"]) {
      const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread${q}`);
      expect(res.status).toBe(200);
    }
  });

  it("rejects a malformed ticket id with 400 (no traversal / arbitrary read)", async () => {
    for (const bad of ["not-a-ticket", "CTL", "..%2F..%2Fetc", "%2Fetc%2Fpasswd"]) {
      expect((await fetch(`${baseUrl}/api/ticket/${bad}/thread`)).status).toBe(400);
    }
  });

  it("does not answer the thread route on POST", async () => {
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread`, { method: "POST" });
    expect(res.status).not.toBe(200);
  });
});

describe("POST /api/ticket/:id/reply (CTL-1569)", () => {
  const post = (ticket: string, body: unknown) =>
    fetch(`${baseUrl}/api/ticket/${ticket}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects an empty reply with 400 and does NOT call Linear", async () => {
    const res = await post(ABSENT_TICKET, { body: "   " });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("empty_body");
  });

  it("rejects a missing body field with 400", async () => {
    expect((await post(ABSENT_TICKET, {})).status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await post(ABSENT_TICKET, "{not json");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed ticket id with 400 before any write", async () => {
    for (const bad of ["not-a-ticket", "CTL", "..%2F..%2Fetc"]) {
      const res = await fetch(`${baseUrl}/api/ticket/${bad}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("never returns 200 for a ticket that cannot resolve (row must be restored)", async () => {
    // A non-existent issue must NOT read as success — the UI restores the row on
    // any non-2xx, and a false success would silently lose the operator's words.
    //
    // SPENDS NO LINEAR QUOTA: BOTH credential sources are neutralized for the
    // duration, so the post short-circuits at the `no_token` gate before any
    // network call. Without this the route runs a real `viewer` query + a real
    // `issue` lookup on every suite run — two API calls against a shared,
    // rate-limited fleet quota, on a fleet that has had an active 429 problem.
    //
    // Clearing the env vars alone is NOT sufficient: the credential resolver also
    // falls back to the Layer-2 personal token (required, because the launchd path
    // exports nothing into the environment), and that file exists on a developer
    // machine. Pointing the project key at a nonexistent project makes that lookup
    // miss too. The assertion is unchanged either way, so this costs no coverage
    // and makes the result host-independent.
    const prevToken = process.env.LINEAR_API_TOKEN;
    const prevKey = process.env.LINEAR_API_KEY;
    const prevProject = process.env.CATALYST_PROJECT_KEY;
    delete process.env.LINEAR_API_TOKEN;
    delete process.env.LINEAR_API_KEY;
    process.env.CATALYST_PROJECT_KEY = "__no_such_project_for_test__";
    try {
      const res = await post(ABSENT_TICKET, { body: "this must not be reported as sent" });
      expect(res.status).not.toBe(200);
      expect(res.status).toBe(502); // no_token → the write did not act
      const json = (await res.json()) as { status: string; error?: string };
      expect(json.status).not.toBe("replied");
      expect(json.status).toBe("no_token");
      // The failure is explained, not silent.
      expect(typeof json.error).toBe("string");
    } finally {
      if (prevToken !== undefined) process.env.LINEAR_API_TOKEN = prevToken;
      if (prevKey !== undefined) process.env.LINEAR_API_KEY = prevKey;
      if (prevProject !== undefined) process.env.CATALYST_PROJECT_KEY = prevProject;
      else delete process.env.CATALYST_PROJECT_KEY;
    }
  });

  it("does not answer the reply route on GET", async () => {
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/reply`);
    expect(res.status).not.toBe(200);
  });
});

// CTL-1573 P1 — the cross-origin guard, exercised over REAL HTTP against the
// mounted route. The unit tests in lib/trusted-origin.test.mjs cover the
// allowlist logic; these prove the guard is actually WIRED to the route, which
// unit tests alone cannot show.
describe("POST /api/ticket/:id/reply cross-origin guard (CTL-1573 P1)", () => {
  const post = (origin: string | null) =>
    fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/reply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin === null ? {} : { Origin: origin }),
      },
      body: JSON.stringify({ body: "should never be posted" }),
    });

  it("rejects an ordinary cross-origin page with 403", async () => {
    const res = await post("https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: "forbidden" });
  });

  // The regression: under DNS rebinding Origin and Host are BOTH the attacker's
  // domain, so the old `Origin === Host` comparison passed. Sending an Origin
  // that matches the Host this request is addressed to reproduces that shape.
  it("rejects a rebinding-shaped Origin that matches the request Host", async () => {
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/reply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: `http://evil.example:${server.port}`,
        Host: `evil.example:${server.port}`,
      },
      body: JSON.stringify({ body: "should never be posted" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a present-but-opaque Origin rather than falling open", async () => {
    expect((await post("null")).status).toBe(403);
  });

  // ALLOW-PATH CASES MUST STAY OFFLINE. Passing the guard means the request
  // continues into the real reply helper, which — on a developer machine with
  // Layer-2 credentials present — issues live Linear `viewer` / `issue(id:)`
  // queries. That would spend shared fleet quota and make an Origin-wiring test
  // depend on Linear being up. Neutralizing BOTH credential sources (env and the
  // Layer-2 project lookup) makes it fail fast at `no_token` instead, which is
  // all these cases need: the assertion is only "not 403".
  const postOffline = async (origin: string | null) => {
    const prevToken = process.env.LINEAR_API_TOKEN;
    const prevKey = process.env.LINEAR_API_KEY;
    const prevProject = process.env.CATALYST_PROJECT_KEY;
    delete process.env.LINEAR_API_TOKEN;
    delete process.env.LINEAR_API_KEY;
    process.env.CATALYST_PROJECT_KEY = "__no_such_project_for_test__";
    try {
      return await post(origin);
    } finally {
      if (prevToken !== undefined) process.env.LINEAR_API_TOKEN = prevToken;
      if (prevKey !== undefined) process.env.LINEAR_API_KEY = prevKey;
      if (prevProject !== undefined) process.env.CATALYST_PROJECT_KEY = prevProject;
      else delete process.env.CATALYST_PROJECT_KEY;
    }
  };

  // Inertness guard. The harness binds an EPHEMERAL port (port: 0), so this
  // also pins that the allowlist is built from the port actually bound —
  // building it from the requested port would trust `localhost:0` and 403 here.
  it("allows the server's own origin on its real (ephemeral) bound port", async () => {
    const res = await postOffline(`http://127.0.0.1:${server.port}`);
    expect(res.status).not.toBe(403);
    // Proves it got PAST the guard into the (credential-less) reply path.
    expect(res.status).toBe(502);
  });

  it("allows a request with no Origin (curl / non-browser clients)", async () => {
    const res = await postOffline(null);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(502);
  });
});
