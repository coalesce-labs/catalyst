// tail-torn.test.ts — CTL-1809. The tailer's JSON.parse catch is the ONLY place in this
// process that can see a TORN line, and until now it swallowed one silently.
//
// A torn line is not the same failure as CTL-1817's unrecognized envelope. Unrecognized
// means a producer emitted a shape the mapper cannot read — the bytes are intact. Torn means
// the LOG ITSELF was damaged in transit: a bash producer's `printf >>` above stdio BUFSIZ is
// ⌈n/BUFSIZ⌉ separate write(2) calls, and a concurrent producer's append lands between them.
// The two must stay separately counted; conflating them would report a write-path defect as a
// producer-shape defect and send whoever reads the number to the wrong file.
//
// The behaviour under test is COUNT AND ADVANCE. The ticket's AC asked for the opposite ("does
// not advance a durable cursor past the line it could not read"); that was overruled, because a
// torn line is permanently corrupt and parking the cursor on it would wedge the forwarder —
// and every other daemon on this log — forever. See execution-core/event-tail.mjs:12-17 for the
// shipped invariant this matches.
//
// Run: cd plugins/dev/scripts/otel-forward && bun test lib/tail-torn.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTailer } from "./tail.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolve(HERE, "..", "index.ts");

interface TailRun {
  forwarded: string[];
  unrecognized: string[];
  torn: string[];
  endOffset: number;
  size: number;
  /** result of a SECOND drain with no new bytes — proves the cursor did not rewind */
  redrainForwarded: string[];
}

// Drive the real tailer over a real file and collect all three outcomes, then drain again.
async function runTailer(lines: string[], wireTornHook = true): Promise<TailRun> {
  const dir = mkdtempSync(join(tmpdir(), "ctl1809-tail-"));
  const filePath = join(dir, "2026-08.jsonl");
  writeFileSync(filePath, lines.join("\n") + "\n");

  const forwarded: string[] = [];
  const unrecognized: string[] = [];
  const torn: string[] = [];
  const redrainForwarded: string[] = [];
  let endOffset = -1;
  const size = statSync(filePath).size;
  const ac = new AbortController();
  try {
    let collecting = forwarded;
    const tailer = createTailer({
      filePath,
      offset: 0,
      onLine: (l) => collecting.push(l),
      onUnrecognized: (l) => unrecognized.push(l),
      ...(wireTornHook ? { onUnparseable: (l: string) => torn.push(l) } : {}),
      signal: ac.signal,
    });
    await tailer.drain();
    endOffset = tailer.currentOffset();
    collecting = redrainForwarded;
    await tailer.drain();
  } finally {
    ac.abort();
    rmSync(dir, { recursive: true, force: true });
  }
  return { forwarded, unrecognized, torn, endOffset, size, redrainForwarded };
}

// A torn line, shaped like the real thing: the RCA measured that all 200 production fragments
// end in `}` and none start with `{` — they are TAIL fragments whose head was never written.
const TORN = '.name":"phase.implement.complete.CTL-1"},"resource":{"service.name":"x"}}';

const clean = (name: string) =>
  JSON.stringify({ ts: "2026-08-13T10:00:00Z", attributes: { "event.name": name }, body: {} });

describe("CTL-1809 — a torn line is counted, skipped, and does not wedge the tail", () => {
  test("a torn line is reported once, never forwarded, and not misfiled as unrecognized", async () => {
    const r = await runTailer([TORN]);
    expect(r.forwarded).toHaveLength(0);
    expect(r.torn).toHaveLength(1);
    expect(r.torn[0]).toBe(TORN);
    // The separation that matters: this is a damaged LOG, not an unreadable ENVELOPE.
    expect(r.unrecognized).toHaveLength(0);
  });

  test("ADVANCE: every valid line after a torn one still reaches the pipeline", async () => {
    const r = await runTailer([clean("before.torn"), TORN, clean("after.torn")]);
    expect(r.torn).toHaveLength(1);
    expect(r.forwarded).toHaveLength(2);
    expect(r.forwarded.map((l) => JSON.parse(l).attributes["event.name"])).toEqual([
      "before.torn",
      "after.torn",
    ]);
  });

  test("ADVANCE: the byte cursor lands at EOF and a re-drain replays nothing", async () => {
    // The concrete failure the rewritten AC avoids. If the tailer parked on the torn line, the
    // offset would stop short of EOF and every subsequent drain would re-read the same bytes —
    // a forwarder that never makes progress again, on damage that will never resolve.
    const r = await runTailer([clean("a"), TORN, clean("b")]);
    expect(r.endOffset).toBe(r.size);
    expect(r.redrainForwarded).toHaveLength(0);
  });

  test("several torn lines in one read are each counted", async () => {
    const r = await runTailer([TORN, clean("mid"), TORN, TORN, clean("end")]);
    expect(r.torn).toHaveLength(3);
    expect(r.forwarded).toHaveLength(2);
  });

  test("a clean batch reports no torn lines (negative case, positively controlled)", async () => {
    const r = await runTailer([clean("a"), clean("b"), clean("c")]);
    expect(r.forwarded).toHaveLength(3);
    expect(r.torn).toHaveLength(0);
    // POSITIVE CONTROL: the same harness, same hook, with one torn line added. Without it, a
    // hook wired to nothing would also report 0 above and read as correct.
    const ctrl = await runTailer([clean("a"), TORN]);
    expect(ctrl.torn).toHaveLength(1);
  });

  // POSITIVE CONTROL for the whole file — the pre-fix world. With no hook wired, the torn line
  // is still dropped and NOTHING anywhere observes it. That is exactly the state that let a
  // 200-fragment corpus sit unreported on the monitor node for a week.
  test("without the hook the drop is invisible — which is the defect", async () => {
    const r = await runTailer([clean("a"), TORN, clean("b")], false);
    expect(r.forwarded).toHaveLength(2); // still advances — the skip was never the bug
    expect(r.torn).toHaveLength(0); // …but the damage is unobservable
  });
});

// ── the in-flight write is not a tear ────────────────────────────────────────────────────────
// A poll landing while a producer is mid-append reads a final fragment with no newline yet.
// That is a HEALTHY write, and counting it made the detector wrong twice over: it reported a
// tear that never happened, and — because `offset` had already advanced to EOF — the next poll
// saw the record's SUFFIX as a fresh line and could count the same record a second time. Every
// other reader on this log (execution-core/event-tail.mjs's parseEventTailChunk,
// broker/tailer.mjs's readNewEvents) already holds the fragment back; this one now does too.
//
// Driven as SEQUENTIAL DRAINS over one growing file, because a single drain cannot show the
// defect: the interleaving IS the test.
async function drainSteps(
  steps: string[]
): Promise<{ forwarded: string[]; torn: string[]; endOffset: number; size: number }> {
  const dir = mkdtempSync(join(tmpdir(), "ctl1809-partial-"));
  const filePath = join(dir, "2026-08.jsonl");
  writeFileSync(filePath, "");
  const forwarded: string[] = [];
  const torn: string[] = [];
  const ac = new AbortController();
  let endOffset = -1;
  let size = -1;
  try {
    const tailer = createTailer({
      filePath,
      offset: 0,
      onLine: (l) => forwarded.push(l),
      onUnparseable: (l: string) => torn.push(l),
      signal: ac.signal,
    });
    for (const chunk of steps) {
      appendFileSync(filePath, chunk);
      await tailer.drain();
    }
    endOffset = tailer.currentOffset();
    size = statSync(filePath).size;
  } finally {
    ac.abort();
    rmSync(dir, { recursive: true, force: true });
  }
  return { forwarded, torn, endOffset, size };
}

describe("CTL-1809 — a mid-append read is not a tear", () => {
  test("a record split across two polls is forwarded ONCE and never counted torn", async () => {
    const record = clean("split.across.polls");
    const cut = Math.floor(record.length / 2);
    // Poll 1 lands mid-append: the producer has written only the first half, no newline.
    // Poll 2 sees the rest.
    const r = await drainSteps([record.slice(0, cut), record.slice(cut) + "\n"]);

    expect(r.torn).toHaveLength(0); // it was never damaged
    expect(r.forwarded).toHaveLength(1); // …and it was not lost either
    expect(JSON.parse(r.forwarded[0]).attributes["event.name"]).toBe("split.across.polls");
    // The suffix was not re-counted as a second line on the later poll.
    expect(r.forwarded.filter((l) => l.includes("split.across.polls"))).toHaveLength(1);
  });

  test("a complete line ahead of the in-flight one is delivered immediately, not held", async () => {
    // The fragment must be held WITHOUT stalling the lines that did finish — holding the whole
    // read back would turn a partial write into forwarding latency for everything behind it.
    const done = clean("finished");
    const half = clean("still.writing").slice(0, 20);
    const r = await drainSteps([`${done}\n${half}`]);

    expect(r.torn).toHaveLength(0);
    expect(r.forwarded).toHaveLength(1);
    expect(JSON.parse(r.forwarded[0]).attributes["event.name"]).toBe("finished");
    // ADVANCE is unchanged: the byte cursor still sits at EOF even with a fragment held, so
    // the held bytes are carried in memory, not re-read.
    expect(r.endOffset).toBe(r.size);
  });

  test("POSITIVE CONTROL: a torn line is still counted across the same sequential drives", async () => {
    // Without this, the two zeros above would also be produced by a harness whose onUnparseable
    // hook is simply never reachable on this code path.
    const r = await drainSteps([`${clean("a")}\n${TORN}\n${clean("b")}\n`]);
    expect(r.torn).toHaveLength(1);
    expect(r.forwarded).toHaveLength(2);
  });

  test("a fragment held across a TRUNCATION is dropped, not stitched onto the new first line", async () => {
    // Rotation-in-place: the held bytes belong to a file that no longer exists. Prepending them
    // would MANUFACTURE a torn line out of two healthy ones.
    const dir = mkdtempSync(join(tmpdir(), "ctl1809-trunc-"));
    const filePath = join(dir, "2026-08.jsonl");
    const forwarded: string[] = [];
    const torn: string[] = [];
    const ac = new AbortController();
    try {
      writeFileSync(filePath, clean("before.truncate").slice(0, 30)); // fragment, no newline
      const tailer = createTailer({
        filePath,
        offset: 0,
        onLine: (l) => forwarded.push(l),
        onUnparseable: (l: string) => torn.push(l),
        signal: ac.signal,
      });
      await tailer.drain(); // holds the fragment
      writeFileSync(filePath, ""); // truncate → size < offset
      await tailer.drain(); // resets offset AND the held fragment
      writeFileSync(filePath, `${clean("after.truncate")}\n`);
      await tailer.drain();
    } finally {
      ac.abort();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(torn).toHaveLength(0);
    expect(forwarded).toHaveLength(1);
    expect(JSON.parse(forwarded[0]).attributes["event.name"]).toBe("after.truncate");
  });
});

// ── index.ts wiring ──────────────────────────────────────────────────────────────────────────
// The hook above is inert unless index.ts passes it to createTailer AND noteUnparseableLine
// actually counts. The counter half is exercised behaviourally by a spawned probe (index.ts's
// `stats` is module-private and its module scope loads config, so an in-process import would be
// order-dependent across bun's shared registry — the same reason index-drop-wiring.test.ts
// spawns). The `createTailer({...})` call itself lives inside `if (import.meta.main)`, i.e. only
// on the daemon path, so it is asserted by source with its own positive control rather than
// left unasserted.
describe("CTL-1809 — index.ts wiring", () => {
  test("noteUnparseableLine counts and warns with a running total", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1809-probe-"));
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      `const idx = await import(process.env.PROBE_INDEX);\n` +
        // Distinct prefixes so each gets a first-sighting warning from the sparse gate; a
        // shared prefix would legitimately be suppressed and prove nothing about the count.
        `idx.noteUnparseableLine("TORN-A" + "x".repeat(80));\n` +
        `idx.noteUnparseableLine("TORN-B" + "x".repeat(80));\n`
    );
    try {
      const res = spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        // cwd inside the package so index.ts's own `pino` import resolves — same reason
        // index-drop-wiring.test.ts pins cwd to its own directory.
        cwd: resolve(HERE, ".."),
        env: {
          ...process.env,
          PROBE_INDEX: INDEX_TS,
          CATALYST_DIR: dir,
          CATALYST_EVENTS_DIR: join(dir, "events"),
          CATALYST_CONFIG_PATH: join(dir, "config.json"),
        },
      });
      const out = `${res.stdout}${res.stderr}`;
      expect(out).toContain('"torn_total":1');
      expect(out).toContain('"torn_total":2');
      expect(out).toContain("TORN event-log line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the tailer is constructed WITH onUnparseable", async () => {
    const src = await Bun.file(INDEX_TS).text();
    const call = src.slice(src.indexOf("createTailer({"));
    const body = call.slice(0, call.indexOf("});") + 3);
    expect(body).toContain("onUnparseable: noteUnparseableLine");
    // POSITIVE CONTROL for the slice above: it must also see the CTL-1817 hook that is known
    // to be present, and must NOT see a key that is known to be absent. Without both, a slice
    // that silently captured the wrong region (or the empty string) would pass by containing
    // nothing and failing nothing.
    expect(body).toContain("onUnrecognized: noteUnrecognizedLine");
    expect(body).not.toContain("onDefinitelyNotAKeyThatExists");
  });
});
