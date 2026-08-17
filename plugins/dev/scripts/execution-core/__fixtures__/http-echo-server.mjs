// http-echo-server.mjs — CTL-1889 test fixture.
//
// ⛔ WHY A SEPARATE PROCESS. linear-write-proxy's `defaultHttpFn` is a `spawnSync` of
// curl, which BLOCKS the calling thread. A `Bun.serve` in the test process can never
// answer it — its fetch handler is JS on that same blocked thread, so the request
// times out and the round-trip assertion "fails" for a reason that has nothing to do
// with the code under test. The only honest positive control is a server in another
// OS process.
//
// Usage: bun http-echo-server.mjs <recordFile> [statusCode]
//   - prints "PORT <n>\n" to stdout once listening (the parent's readiness signal)
//   - appends one JSON line per received request to <recordFile>
import { appendFileSync } from "node:fs";

const recordFile = process.argv[2];
const status = Number(process.argv[3] ?? 200);

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
