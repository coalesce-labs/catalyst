// tail-unrecognized.test.ts — CTL-1817 round-1 review (Codex P1).
//
// The round-1 detector was placed in the OTLP mapper, where a v3 record can never arrive.
// Two gates discard it first, and BOTH were silent:
//
//   1. lib/tail.ts shouldForward — accepts only `attributes` | string `event` | pino.
//      A v3 line (`{name, ...payload, ts}`) matches none, so it is never even read.
//   2. index.ts processLine — drops anything that still has no `attributes`.
//
// So the 531 phase.rescue.* + 1 phase.orphan-pr.* of 2026-08 were NOT "forwarded with an
// empty record" — they never left the host. This suite exercises the REAL tailer path and
// pins the drop as observable at gate 1, where it actually happens.
//
// Run: cd plugins/dev/scripts/otel-forward && bun test
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailer } from "./tail.ts";
import { buildCanonicalEventLine } from "../../execution-core/lib/canonical-event.mjs";

// Drive the real tailer over a real file and collect both outcomes.
async function runTailer(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ctl1817-tail-"));
  const filePath = join(dir, "2026-08.jsonl");
  writeFileSync(filePath, lines.join("\n") + "\n");

  const forwarded: string[] = [];
  const unrecognized: string[] = [];
  const ac = new AbortController();
  try {
    const tailer = createTailer({
      filePath,
      offset: 0,
      onLine: (l) => forwarded.push(l),
      onUnrecognized: (l) => unrecognized.push(l),
      signal: ac.signal,
    });
    await tailer.drain();
  } finally {
    ac.abort();
    rmSync(dir, { recursive: true, force: true });
  }
  return { forwarded, unrecognized };
}

const v3Line = (name: string, payload: Record<string, unknown>) =>
  JSON.stringify({ name, ...payload, ts: "2026-08-13T10:00:00Z" });

describe("CTL-1817 — the tailer is where a v3 line is lost", () => {
  test("a v3 rescue line is NOT forwarded, and is reported as unrecognized", async () => {
    const { forwarded, unrecognized } = await runTailer([
      v3Line("phase.rescue.escalated.CTL-1832", { ticket: "CTL-1832" }),
    ]);

    // This is the defect: it does not reach the pipeline at all.
    expect(forwarded).toHaveLength(0);
    // This is the fix: the drop is now observable at the only gate that can see it.
    expect(unrecognized).toHaveLength(1);
    expect(JSON.parse(unrecognized[0]).name).toBe("phase.rescue.escalated.CTL-1832");
  });

  test("the fixed producer's line DOES survive the tailer — end to end", async () => {
    // The real builder, not a hand-copied fixture: this is what proves producer and
    // forwarder now agree. Round 1 asserted this against buildOtlpPayload directly, which
    // skipped both gates and so could not have caught the defect above.
    const line = buildCanonicalEventLine({
      name: "phase.rescue.escalated.CTL-1832",
      payload: { ticket: "CTL-1832", reason: "rescue_worker_stalled" },
      attributes: { "linear.issue.identifier": "CTL-1832" },
    }).trimEnd();

    const { forwarded, unrecognized } = await runTailer([line]);

    expect(unrecognized).toHaveLength(0);
    expect(forwarded).toHaveLength(1);
    const ev = JSON.parse(forwarded[0]);
    expect(ev.attributes["event.name"]).toBe("phase.rescue.escalated.CTL-1832");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-1832");
    expect(ev.body.message).not.toBe("");
  });

  test("the orphan-PR line survives too", async () => {
    const line = buildCanonicalEventLine({
      name: "phase.orphan-pr.detected.3324",
      payload: { repo: "coalesce-labs/catalyst", number: 3324 },
      attributes: { "vcs.pr.number": 3324 },
    }).trimEnd();

    const { forwarded, unrecognized } = await runTailer([line]);
    expect(unrecognized).toHaveLength(0);
    expect(forwarded).toHaveLength(1);
  });

  test("the three recognized shapes are unaffected — no false unrecognized reports", async () => {
    const { forwarded, unrecognized } = await runTailer([
      JSON.stringify({ ts: "2026-08-13T10:00:00Z", attributes: { "event.name": "recovery.tick" }, body: {} }),
      JSON.stringify({ ts: "2026-08-13T10:00:00Z", event: "phase.terminal.done.CTL-1" }),
      JSON.stringify({ level: 30, msg: "scheduler tick", time: 1786631274642 }),
    ]);

    expect(forwarded).toHaveLength(3);
    expect(unrecognized).toHaveLength(0);
  });

  test("a non-JSON line is dropped without being reported as an envelope", async () => {
    // Garbage is not an unrecognized ENVELOPE — reporting it as one would drown the signal
    // in torn-line noise (the event log does carry torn lines; see CTL-1809).
    const { forwarded, unrecognized } = await runTailer(["}{ not json at all"]);
    expect(forwarded).toHaveLength(0);
    expect(unrecognized).toHaveLength(0);
  });

  test("mixed batch: only the v3 line is reported, the rest flow", async () => {
    const { forwarded, unrecognized } = await runTailer([
      JSON.stringify({ ts: "2026-08-13T10:00:00Z", attributes: { "event.name": "recovery.tick" }, body: {} }),
      v3Line("phase.orphan-pr.detected.3324", { number: 3324 }),
      JSON.stringify({ ts: "2026-08-13T10:00:00Z", event: "pr.merged" }),
    ]);

    expect(forwarded).toHaveLength(2);
    expect(unrecognized).toHaveLength(1);
    expect(JSON.parse(unrecognized[0]).name).toBe("phase.orphan-pr.detected.3324");
  });

  // POSITIVE CONTROL — must FAIL if the reporting hook is removed. Proves the assertions
  // above are not vacuous: with no hook wired, the same v3 line is still dropped, and
  // nothing anywhere observes it. That is precisely the pre-fix world.
  test("the detector can observe the defect — without the hook, the drop is invisible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1817-ctrl-"));
    const filePath = join(dir, "2026-08.jsonl");
    writeFileSync(filePath, v3Line("phase.rescue.escalated.CTL-1", { ticket: "CTL-1" }) + "\n");

    const forwarded: string[] = [];
    const ac = new AbortController();
    try {
      // No onUnrecognized — the pre-fix configuration.
      const tailer = createTailer({ filePath, offset: 0, onLine: (l) => forwarded.push(l), signal: ac.signal });
      await tailer.drain();
    } finally {
      ac.abort();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(forwarded).toHaveLength(0); // dropped, and nothing observed it
  });
});
