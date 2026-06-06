// processes.test.mjs — CTL-812 Domain 3 (process attribution). Exercises the
// ps-line parser (incl. the args-with-spaces / fixed-width-comm case), top-N
// ranking + tie-break, the worker-map join both directly and via an ancestor
// ppid chain, the missing-workers-dir → all-unattributed path, and the emitted
// host.process.sampled envelope shape against the telemetry contract.
//
// All I/O is injected: psLines / readWorkerMap / emit / now are fakes, so no
// real ps, no real filesystem (except the defaultReadWorkerMap test, which uses
// a temp CATALYST_DIR), and no real clock.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test processes.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  parsePsLines,
  rankTopN,
  attributeRow,
  sampleProcesses,
  defaultReadWorkerMap,
  PROCESS_EVENT_SAMPLED,
} from "./processes.mjs";

const FIXED_NOW = "2026-06-07T12:00:00Z";

// A recording emit seam — collects the envelopes the sampler hands it.
function recordingEmit() {
  const envelopes = [];
  return { emit: (e) => envelopes.push(e), envelopes };
}

// ─── ps parsing ──────────────────────────────────────────────────────────────

// macOS clamps the intermediate `comm` column to exactly 16 chars, space-padded,
// then a single separator, then the full `args` column to EOL. psRow builds a
// line in that exact layout so fixtures match real `ps -axo …,comm=,args=`
// output without hand-counting spaces. `comm` is padded/clamped to 16; `args` is
// appended verbatim (and may contain spaces — the whole point of args= LAST).
function psRow({ pid, ppid, cpu, rss, comm, args }) {
  const commCol = comm.padEnd(16, " ").slice(0, 16);
  const tail = args === undefined ? commCol.trimEnd() : `${commCol} ${args}`;
  return `${pid} ${ppid} ${cpu} ${rss} ${tail}`;
}

describe("parsePsLines", () => {
  test("parses the 4 numeric leading fields, comm column, and full args", () => {
    const line = psRow({
      pid: 4321,
      ppid: 4000,
      cpu: 12.5,
      rss: 524288,
      comm: "/bin/node", // short enough to survive the 16-char column clamp
      args: "/usr/local/bin/node server.mjs --port 8080",
    });
    const [row] = parsePsLines([line]);
    expect(row.pid).toBe(4321);
    expect(row.ppid).toBe(4000);
    expect(row.cpu_pct).toBe(12.5);
    expect(row.rss_kb).toBe(524288);
    // command = basename(comm) lowercased.
    expect(row.command).toBe("node");
    // args (payload-only) is the full command line, spaces and flags intact.
    expect(row.args).toBe("/usr/local/bin/node server.mjs --port 8080");
  });

  test("args-with-spaces: flags and a path with a space survive verbatim", () => {
    const line = psRow({
      pid: 900,
      ppid: 1,
      cpu: 0.0,
      rss: 10240,
      comm: "/Applications/Foo Bar.app/Contents/MacOS/Foo",
      args: '/Applications/Foo Bar.app/Contents/MacOS/Foo --flag "a b c"',
    });
    const [row] = parsePsLines([line]);
    expect(row.pid).toBe(900);
    // basename of the 16-char-clamped comm "/Applications/Fo" → "fo".
    expect(row.command).toBe("fo");
    // args is the full untruncated command line, spaces and quotes intact.
    expect(row.args).toBe('/Applications/Foo Bar.app/Contents/MacOS/Foo --flag "a b c"');
  });

  test("lowercases the command basename", () => {
    const line = psRow({
      pid: 10,
      ppid: 1,
      cpu: 0.0,
      rss: 2048,
      comm: "/opt/Claude/CLI", // 15 chars, fits the column un-truncated
      args: "/opt/Claude/CLI --serve",
    });
    const [row] = parsePsLines([line]);
    expect(row.command).toBe("cli");
  });

  test("documents the 16-char comm-column clamp: a long comm path truncates", () => {
    // macOS clamps the intermediate comm column to 16 chars, so a long
    // executable path basename can be cut. This is an accepted ps limitation;
    // the test pins the behavior so it is intentional, not a surprise.
    const line = psRow({
      pid: 33,
      ppid: 1,
      cpu: 0.0,
      rss: 2048,
      comm: "/usr/local/bin/node", // 19 chars → clamped to "/usr/local/bin/n"
      args: "/usr/local/bin/node x.mjs",
    });
    const [row] = parsePsLines([line]);
    expect(row.command).toBe("n");
    // …but the full, untruncated command line is preserved in args (payload).
    expect(row.args).toBe("/usr/local/bin/node x.mjs");
  });

  test("login-shell argv[0] (-zsh) does NOT mislead command: comm wins", () => {
    // Real macOS: a login shell's args is `-zsh` but comm is `/bin/zsh`.
    const line = psRow({ pid: 77, ppid: 1, cpu: 0.1, rss: 4096, comm: "/bin/zsh", args: "-zsh" });
    const [row] = parsePsLines([line]);
    expect(row.command).toBe("zsh");
  });

  test("skips blank lines and malformed (non-numeric leading) lines", () => {
    const good = psRow({ pid: 88, ppid: 1, cpu: 0.0, rss: 4096, comm: "/bin/bash", args: "bash" });
    const rows = parsePsLines(["", "   ", "not a ps line at all", good, "\t"]);
    expect(rows.length).toBe(1);
    expect(rows[0].pid).toBe(88);
    expect(rows[0].command).toBe("bash");
  });

  test("handles a comm-only line (no args column)", () => {
    // No args field: the whole tail is the (sub-16-char) comm.
    const [row] = parsePsLines([psRow({ pid: 5, ppid: 1, cpu: 0.0, rss: 1024, comm: "bun" })]);
    expect(row.pid).toBe(5);
    expect(row.command).toBe("bun");
    expect(row.args).toBe("bun");
  });

  test("ignores non-string entries", () => {
    expect(parsePsLines([null, undefined, 123]).length).toBe(0);
  });
});

// ─── ranking ─────────────────────────────────────────────────────────────────

describe("rankTopN", () => {
  function rowsForRank() {
    return [
      { pid: 1, rss_kb: 100, cpu_pct: 1 },
      { pid: 2, rss_kb: 900, cpu_pct: 5 },
      { pid: 3, rss_kb: 500, cpu_pct: 2 },
      { pid: 4, rss_kb: 500, cpu_pct: 9 }, // ties pid 3 on RSS; higher CPU wins the tie
      { pid: 5, rss_kb: 50, cpu_pct: 0 },
    ];
  }

  test("returns the N largest by RSS, descending", () => {
    const top = rankTopN(rowsForRank(), 3);
    expect(top.map((r) => r.pid)).toEqual([2, 4, 3]);
  });

  test("breaks RSS ties by CPU descending", () => {
    const top = rankTopN(rowsForRank(), 5);
    // pid 4 (cpu 9) precedes pid 3 (cpu 2) despite equal RSS.
    const idx4 = top.findIndex((r) => r.pid === 4);
    const idx3 = top.findIndex((r) => r.pid === 3);
    expect(idx4).toBeLessThan(idx3);
  });

  test("does not mutate the input array", () => {
    const rows = rowsForRank();
    const before = rows.map((r) => r.pid);
    rankTopN(rows, 2);
    expect(rows.map((r) => r.pid)).toEqual(before);
  });

  test("floors topN to at least 1", () => {
    expect(rankTopN(rowsForRank(), 0).length).toBe(1);
    expect(rankTopN(rowsForRank(), -5).length).toBe(1);
  });
});

// ─── attribution (ppid chain) ──────────────────────────────────────────────────

describe("attributeRow", () => {
  // worker → node → claude tree: only the top worker pid is in the worker map.
  function tree() {
    const rows = [
      { pid: 100, ppid: 1 }, // the worker root
      { pid: 200, ppid: 100 }, // node child
      { pid: 300, ppid: 200 }, // claude grandchild
      { pid: 999, ppid: 1 }, // unrelated process
    ];
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const workerMap = new Map([[100, { ticket: "CTL-700", phase: "implement", bg_job_id: "abc" }]]);
    return { byPid, workerMap };
  }

  test("direct match: the process pid is in the worker map", () => {
    const { byPid, workerMap } = tree();
    expect(attributeRow({ pid: 100, ppid: 1 }, byPid, workerMap).ticket).toBe("CTL-700");
  });

  test("via-ancestor match: a grandchild inherits the worker through the ppid chain", () => {
    const { byPid, workerMap } = tree();
    const hit = attributeRow({ pid: 300, ppid: 200 }, byPid, workerMap);
    expect(hit).not.toBeNull();
    expect(hit.ticket).toBe("CTL-700");
    expect(hit.phase).toBe("implement");
  });

  test("unrelated process resolves to null", () => {
    const { byPid, workerMap } = tree();
    expect(attributeRow({ pid: 999, ppid: 1 }, byPid, workerMap)).toBeNull();
  });

  test("stops at the chain cap and tolerates cycles without looping forever", () => {
    // A pathological ppid cycle: 1→2→1. attributeRow must terminate.
    const byPid = new Map([
      [1, { pid: 1, ppid: 2 }],
      [2, { pid: 2, ppid: 1 }],
    ]);
    const workerMap = new Map(); // no match anywhere
    expect(attributeRow({ pid: 1, ppid: 2 }, byPid, workerMap)).toBeNull();
  });
});

// ─── sampleProcesses (end to end with injected seams) ───────────────────────────

describe("sampleProcesses", () => {
  // A small ps snapshot: a worker root (1000), its node+claude descendants, a
  // big unrelated process, and a tiny one that should fall outside top-N. comm
  // paths are kept short so basename survives the 16-char comm-column clamp.
  function psSnapshot() {
    return [
      psRow({ pid: 1000, ppid: 1, cpu: 3.0, rss: 800000, comm: "/bin/node", args: "/bin/node worker.mjs CTL-555" }),
      psRow({ pid: 1100, ppid: 1000, cpu: 10.0, rss: 600000, comm: "/bin/node", args: "/bin/node mcp-server.mjs" }),
      psRow({ pid: 1200, ppid: 1100, cpu: 25.5, rss: 900000, comm: "/bin/claude", args: "/opt/claude/claude --bg --resume" }),
      psRow({ pid: 2000, ppid: 1, cpu: 0.5, rss: 950000, comm: "/bin/Chrome", args: "/Applications/Chrome.app/Contents/MacOS/Chrome --type=gpu" }),
      psRow({ pid: 50, ppid: 1, cpu: 0.0, rss: 1024, comm: "/usr/sbin/cupsd", args: "/usr/sbin/cupsd -l" }),
    ];
  }

  // Worker map: only the worker ROOT pid (1000) is known; descendants attribute
  // via the ppid chain.
  function workerMap() {
    return new Map([[1000, { ticket: "CTL-555", phase: "implement", bg_job_id: "job-9" }]]);
  }

  test("emits one host.process.sampled envelope per top-N row", () => {
    const { emit, envelopes } = recordingEmit();
    const out = sampleProcesses({
      psLines: psSnapshot,
      readWorkerMap: workerMap,
      topN: 3,
      emit,
      now: () => FIXED_NOW,
    });
    expect(out.length).toBe(3);
    expect(envelopes.length).toBe(3);
    for (const e of envelopes) {
      expect(e.attributes["event.name"]).toBe(PROCESS_EVENT_SAMPLED);
      expect(e.attributes["event.entity"]).toBe("host");
      expect(e.attributes["event.action"]).toBe("process.sampled");
      expect(e.attributes["event.label"]).toBe(hostname());
      expect(e.resource["service.name"]).toBe("catalyst.agent");
      expect(e.ts).toBe(FIXED_NOW);
    }
  });

  test("top-N is by RSS desc: chrome(950k) > claude(900k) > worker-root(800k)", () => {
    const { emit, envelopes } = recordingEmit();
    sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 3, emit });
    const pids = envelopes.map((e) => e.body.payload.pid);
    expect(pids).toEqual([2000, 1200, 1000]);
  });

  test("contract: attributes carry command/cpu/rss; payload carries pid/ppid/args/bg_job_id", () => {
    const { emit, envelopes } = recordingEmit();
    sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit });
    const claude = envelopes.find((e) => e.body.payload.pid === 1200);
    // dot-form value attributes
    expect(claude.attributes["process.command"]).toBe("claude");
    expect(claude.attributes["process.cpu_pct"]).toBe(25.5);
    expect(claude.attributes["process.rss_mb"]).toBe(Math.round(900000 / 1024));
    // high-cardinality fields live ONLY in the payload, never as attributes
    expect("pid" in claude.attributes).toBe(false);
    expect("args" in claude.attributes).toBe(false);
    expect(claude.body.payload.pid).toBe(1200);
    expect(claude.body.payload.ppid).toBe(1100);
    expect(claude.body.payload.args).toBe("/opt/claude/claude --bg --resume");
  });

  test("direct attribution: the worker root row gets ticket/phase/bg_job_id", () => {
    const { emit, envelopes } = recordingEmit();
    sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit });
    const root = envelopes.find((e) => e.body.payload.pid === 1000);
    expect(root.attributes["process.ticket"]).toBe("CTL-555");
    expect(root.attributes["process.phase"]).toBe("implement");
    expect(root.body.payload.bg_job_id).toBe("job-9");
  });

  test("via-ancestor attribution: the claude grandchild inherits the worker's ticket", () => {
    const { emit, envelopes } = recordingEmit();
    sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit });
    const claude = envelopes.find((e) => e.body.payload.pid === 1200);
    expect(claude.attributes["process.ticket"]).toBe("CTL-555");
    expect(claude.attributes["process.phase"]).toBe("implement");
    expect(claude.body.payload.bg_job_id).toBe("job-9");
  });

  test("unattributed process omits ticket/phase attrs and has null bg_job_id", () => {
    const { emit, envelopes } = recordingEmit();
    sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit });
    const chrome = envelopes.find((e) => e.body.payload.pid === 2000);
    expect("process.ticket" in chrome.attributes).toBe(false);
    expect("process.phase" in chrome.attributes).toBe(false);
    expect(chrome.body.payload.bg_job_id).toBeNull();
  });

  test("missing workers dir → empty map → every process unattributed", () => {
    const { emit, envelopes } = recordingEmit();
    sampleProcesses({
      psLines: psSnapshot,
      readWorkerMap: () => new Map(), // simulate no workers dir
      topN: 5,
      emit,
    });
    for (const e of envelopes) {
      expect("process.ticket" in e.attributes).toBe(false);
      expect("process.phase" in e.attributes).toBe(false);
      expect(e.body.payload.bg_job_id).toBeNull();
    }
  });

  test("a throwing psLines seam degrades to [] (never throws)", () => {
    let out;
    expect(() => {
      out = sampleProcesses({
        psLines: () => {
          throw new Error("ps exploded");
        },
        readWorkerMap: () => new Map(),
        emit: () => {},
      });
    }).not.toThrow();
    expect(out).toEqual([]);
  });

  test("a throwing readWorkerMap seam degrades to all-unattributed (never throws)", () => {
    const { emit, envelopes } = recordingEmit();
    expect(() => {
      sampleProcesses({
        psLines: psSnapshot,
        readWorkerMap: () => {
          throw new Error("fs exploded");
        },
        topN: 2,
        emit,
      });
    }).not.toThrow();
    expect(envelopes.length).toBe(2);
    for (const e of envelopes) expect("process.ticket" in e.attributes).toBe(false);
  });

  test("a throwing emit does not abort the tick (best-effort per row)", () => {
    let calls = 0;
    const out = sampleProcesses({
      psLines: psSnapshot,
      readWorkerMap: workerMap,
      topN: 3,
      emit: () => {
        calls++;
        throw new Error("emit boom");
      },
      now: () => FIXED_NOW,
    });
    // All 3 envelopes were built and emit was attempted for each.
    expect(out.length).toBe(3);
    expect(calls).toBe(3);
  });
});

// ─── defaultReadWorkerMap (real filesystem via a temp CATALYST_DIR) ──────────────

describe("defaultReadWorkerMap", () => {
  function makeWorkersRoot() {
    const dir = mkdtempSync(join(tmpdir(), "ctl812-proc-"));
    return join(dir, "execution-core", "workers");
  }

  function writeSignal(root, ticket, file, obj) {
    const d = join(root, ticket);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, file), JSON.stringify(obj));
  }

  test("builds pid→{ticket,phase,bg_job_id} from pid-bearing signals", () => {
    const root = makeWorkersRoot();
    writeSignal(root, "CTL-100", "phase-implement.json", {
      ticket: "CTL-100",
      phase: "implement",
      pid: 4242,
      bg_job_id: "bg-1",
    });
    const map = defaultReadWorkerMap(root);
    expect(map.get(4242)).toEqual({ ticket: "CTL-100", phase: "implement", bg_job_id: "bg-1" });
  });

  test("skips signals without a numeric pid (bg-only nested phase signals)", () => {
    const root = makeWorkersRoot();
    // The common on-disk shape: a phase signal with bg_job_id but no pid.
    writeSignal(root, "CTL-200", "phase-triage.json", {
      ticket: "CTL-200",
      phase: "triage",
      bg_job_id: "bg-2",
    });
    expect(defaultReadWorkerMap(root).size).toBe(0);
  });

  test("tolerates malformed JSON and unreadable entries (never throws)", () => {
    const root = makeWorkersRoot();
    const d = join(root, "CTL-300");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "phase-implement.json"), "{ not valid json");
    writeSignal(root, "CTL-301", "phase-implement.json", { ticket: "CTL-301", pid: 5151 });
    let map;
    expect(() => {
      map = defaultReadWorkerMap(root);
    }).not.toThrow();
    // The good signal still joins; the malformed one is silently skipped.
    expect(map.get(5151).ticket).toBe("CTL-301");
    expect(map.size).toBe(1);
  });

  test("missing workers dir returns an empty map (no throw)", () => {
    const map = defaultReadWorkerMap(join(tmpdir(), "ctl812-does-not-exist-xyz", "workers"));
    expect(map.size).toBe(0);
  });

  test("first writer wins per pid (a duplicate pid does not clobber)", () => {
    const root = makeWorkersRoot();
    writeSignal(root, "CTL-400", "a.json", { ticket: "CTL-400", phase: "p1", pid: 7000 });
    writeSignal(root, "CTL-400", "b.json", { ticket: "CTL-400", phase: "p2", pid: 7000 });
    const map = defaultReadWorkerMap(root);
    expect(map.size).toBe(1);
    expect(map.get(7000).ticket).toBe("CTL-400");
  });
});
