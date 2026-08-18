// http-echo-server.mjs — CTL-1889 test fixture.
//
// ⛔ WHY A SEPARATE PROCESS. linear-write-proxy's `defaultHttpFn` is a `spawnSync` of
// curl, which BLOCKS the calling thread. A `Bun.serve` in the test process can never
// answer it — its fetch handler is JS on that same blocked thread, so the request
// times out and the round-trip assertion "fails" for a reason that has nothing to do
// with the code under test. The only honest positive control is a server in another
// OS process.
//
// Usage: bun http-echo-server.mjs <recordFile> [statusCode] [deadlineMs]
//   - prints "PORT <n>\n" to stdout once listening (the parent's readiness signal)
//   - appends one JSON line per received request to <recordFile>
//   - EXITS ON ITS OWN after `deadlineMs`, whatever the parent does
import { appendFileSync } from "node:fs";

const recordFile = process.argv[2];
const status = Number(process.argv[3] ?? 200);

// ⛔ SELF-LIMITING, BECAUSE CLEANUP MUST NOT BE LOAD-BEARING (Codex #3489 round 2, P1;
// AGENTS.md "Spawning a background process"). The parent's `afterEach` kill is
// best-effort by construction: it does not run if the test runner is interrupted
// (^C, a CI step timeout, a crash in another suite), and a `&`-style orphan reparents
// to PID 1 and serves forever. That is not hypothetical here — this repo has already
// burned ~4 CPU-cores for 16.5 h on leaked children whose spawning script reported
// `cleanup verified`. So the deadline lives in the CHILD, where no parent failure can
// skip it, and it is a timer rather than a spin loop (an empty deadline loop burns a
// whole core for its duration, which is the same incident from the other end).
//
// Overridable ONLY so the deadline itself can be proven to fire in ~1 s instead of
// making the suite wait out the default — a test asserting the process exits with no
// kill from the parent. A guardrail nothing exercises is a guardrail nobody knows is
// broken; an unparseable/absent value falls back to the default rather than to
// "no deadline".
const rawDeadline = Number(process.argv[4] ?? process.env.CTL1889_FIXTURE_DEADLINE_MS);
const deadlineMs = Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : 60_000;
setTimeout(() => {
  process.stderr.write(`http-echo-server: self-terminating after ${deadlineMs}ms deadline\n`);
  process.exit(0);
}, deadlineMs);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    appendFileSync(
      recordFile,
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        headerNames: [...req.headers.keys()],
        body: await req.text(),
      }) + "\n",
    );
    // Answer in the CTC-509 shape, not a generic {ok}: the classifier's verdict comes
    // from the body's discriminated `outcome`, so a fixture that omits it would exercise
    // the "unreadable-outcome" path while claiming to be a success round-trip.
    //
    // ⚠️ 401/403 answer with PLAIN TEXT, because the real thing does. Those come from
    // the auth layer, which returns bare strings ("missing account" — measured against
    // the live mirror), and only the route handlers past it speak the outcome envelope.
    // A fixture that wrapped auth failures in an outcome would quietly prove the wrong
    // branch of the classifier and leave the status-class fallback untested.
    if (status === 401 || status === 403) {
      return new Response("missing account", { status });
    }
    return new Response(
      JSON.stringify(
        status < 400
          ? { outcome: "succeeded", attempts: 1 }
          : { outcome: "rejected", reason: `fixture status ${status}` },
      ),
      { status },
    );
  },
});

process.stdout.write(`PORT ${server.port}\n`);
