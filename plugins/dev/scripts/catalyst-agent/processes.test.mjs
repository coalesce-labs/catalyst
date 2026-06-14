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
  splitCommArgs,
  deriveCommand,
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
    const [row] = parsePsLines([line], { platform: "darwin" });
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
    const [row] = parsePsLines([line], { platform: "darwin" });
    expect(row.pid).toBe(900);
    // The macOS comm column is clamped to 16 ("/Applications/Fo"). deriveCommand
    // heals it from argv[0] in args: comm is a prefix of the first args token
    // "/Applications/Foo", so basename(argv[0]) → "foo" (better than the clamped
    // "fo"; argv[0] itself stops at the embedded space, but the basename is right).
    expect(row.command).toBe("foo");
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
    const [row] = parsePsLines([line], { platform: "darwin" });
    expect(row.command).toBe("cli");
  });

  test("macOS 16-char comm clamp is HEALED from argv[0] in args (CTL-812 fix)", () => {
    // macOS clamps the comm column to 16 chars ("/usr/local/bin/node" → the
    // truncated "/usr/local/bin/n"), which would yield the misleading command
    // "n". deriveCommand recovers the real command from the full argv[0] in the
    // args column: comm is a prefix of "/usr/local/bin/node", so basename(argv[0])
    // → "node". (Pre-fix this asserted "n"; the review flagged the truncation.)
    const line = psRow({
      pid: 33,
      ppid: 1,
      cpu: 0.0,
      rss: 2048,
      comm: "/usr/local/bin/node", // 19 chars → comm column clamped to "/usr/local/bin/n"
      args: "/usr/local/bin/node x.mjs",
    });
    const [row] = parsePsLines([line], { platform: "darwin" });
    expect(row.command).toBe("node");
    // …and the full, untruncated command line is preserved in args (payload).
    expect(row.args).toBe("/usr/local/bin/node x.mjs");
  });

  test("macOS deep-path comm (logd, framework) heals to the real command", () => {
    // The exact cases the CTL-812 review reproduced against real `ps` output:
    //   /usr/libexec/logd → comm clamped to "/usr/libexec/log" → would give "log"
    //   /System/Library/PrivateFrameworks/… → "/System/Library/" → would give "library"
    // deriveCommand heals both from the full argv[0] in args.
    const logd = psRow({
      pid: 343, ppid: 1, cpu: 0.7, rss: 44192,
      comm: "/usr/libexec/logd", // clamps to "/usr/libexec/log"
      args: "/usr/libexec/logd",
    });
    const framework = psRow({
      pid: 598, ppid: 1, cpu: 0.0, rss: 15296,
      comm: "/System/Library/PrivateFrameworks/ModelCatalogRuntime.framework/Versions/A/modelcatalogd",
      args: "/System/Library/PrivateFrameworks/ModelCatalogRuntime.framework/Versions/A/modelcatalogd",
    });
    const [a] = parsePsLines([logd], { platform: "darwin" });
    const [b] = parsePsLines([framework], { platform: "darwin" });
    expect(a.command).toBe("logd"); // not the truncated "log"
    expect(b.command).toBe("modelcatalogd"); // not the truncated "library"
  });

  test("Linux comm column is natural-width (not 16-padded) — parsed correctly", () => {
    // CTL-812 review: Linux `ps -o comm=,args=` does NOT fixed-pad comm to 16; it
    // renders comm at its natural width with a single space before args. The
    // darwin 16-char slice would split mid-token here. With platform:"linux" the
    // first whitespace token is comm and the remainder is args.
    //
    // A SHORT comm (< 16): the macOS slice would absorb the leading args into
    // comm; the linux split keeps them separate.
    const shortComm = "1234 1 3.1 524288 node /usr/bin/node server.mjs --port 8080";
    const [row] = parsePsLines([shortComm], { platform: "linux" });
    expect(row.pid).toBe(1234);
    expect(row.command).toBe("node");
    expect(row.args).toBe("/usr/bin/node server.mjs --port 8080");

    // A LONG comm (> 16) is NOT truncated on Linux: comm renders in full.
    const longComm = "55 1 0.0 2048 systemd-resolved /lib/systemd/systemd-resolved";
    const [row2] = parsePsLines([longComm], { platform: "linux" });
    expect(row2.command).toBe("systemd-resolved");
    expect(row2.args).toBe("/lib/systemd/systemd-resolved");
  });

  test("login-shell argv[0] (-zsh) does NOT mislead command: comm wins", () => {
    // Real macOS: a login shell's args is `-zsh` but comm is `/bin/zsh`.
    const line = psRow({ pid: 77, ppid: 1, cpu: 0.1, rss: 4096, comm: "/bin/zsh", args: "-zsh" });
    const [row] = parsePsLines([line], { platform: "darwin" });
    expect(row.command).toBe("zsh");
  });

  test("skips blank lines and malformed (non-numeric leading) lines", () => {
    const good = psRow({ pid: 88, ppid: 1, cpu: 0.0, rss: 4096, comm: "/bin/bash", args: "bash" });
    const rows = parsePsLines(["", "   ", "not a ps line at all", good, "\t"], { platform: "darwin" });
    expect(rows.length).toBe(1);
    expect(rows[0].pid).toBe(88);
    expect(rows[0].command).toBe("bash");
  });

  test("handles a comm-only line (no args column)", () => {
    // No args field: the whole tail is the (sub-16-char) comm.
    const [row] = parsePsLines([psRow({ pid: 5, ppid: 1, cpu: 0.0, rss: 1024, comm: "bun" })], {
      platform: "darwin",
    });
    expect(row.pid).toBe(5);
    expect(row.command).toBe("bun");
    expect(row.args).toBe("bun");
  });

  test("ignores non-string entries", () => {
    expect(parsePsLines([null, undefined, 123]).length).toBe(0);
  });
});

// ─── splitCommArgs (per-platform comm column) ──────────────────────────────────

describe("splitCommArgs", () => {
  test("darwin: fixed 16-char space-padded comm column, args to EOL", () => {
    // "node" padded to 16, a space, then args. The 16-slice peels comm cleanly.
    const tail = "node            /usr/bin/node x.mjs --port 8080";
    expect(splitCommArgs(tail, "darwin")).toEqual({
      comm: "node",
      args: "/usr/bin/node x.mjs --port 8080",
    });
  });

  test("darwin: a comm-only tail shorter than the column has empty args", () => {
    expect(splitCommArgs("bun", "darwin")).toEqual({ comm: "bun", args: "" });
  });

  test("linux: comm is the first whitespace token (natural width), args is the rest", () => {
    // No 16-padding: a SHORT comm would absorb args under the darwin slice; the
    // linux split keeps them separate.
    expect(splitCommArgs("node /usr/bin/node x.mjs", "linux")).toEqual({
      comm: "node",
      args: "/usr/bin/node x.mjs",
    });
    // A LONG comm (> 16) is NOT truncated on linux.
    expect(splitCommArgs("systemd-resolved /lib/systemd/systemd-resolved", "linux")).toEqual({
      comm: "systemd-resolved",
      args: "/lib/systemd/systemd-resolved",
    });
  });

  test("linux: a comm-only tail (no space) has empty args", () => {
    expect(splitCommArgs("bun", "linux")).toEqual({ comm: "bun", args: "" });
  });
});

// ─── deriveCommand (heal macOS truncation, defer to comm on rewritten argv0) ──

describe("deriveCommand", () => {
  test("comm is authoritative when it is NOT a truncated prefix of argv[0] (login shell)", () => {
    // comm "/bin/zsh", argv0 "-zsh" — argv0 was rewritten; comm wins → "zsh".
    expect(deriveCommand("/bin/zsh", "-zsh")).toBe("zsh");
  });

  test("heals a truncated comm from the full argv[0] (logd, framework)", () => {
    // macOS clamps comm to 16; argv[0] in args carries the full path.
    expect(deriveCommand("/usr/libexec/log", "/usr/libexec/logd")).toBe("logd");
    expect(
      deriveCommand(
        "/System/Library/",
        "/System/Library/PrivateFrameworks/ModelCatalogRuntime.framework/Versions/A/modelcatalogd",
      ),
    ).toBe("modelcatalogd");
  });

  test("comm wins when it equals argv[0] (no truncation to heal)", () => {
    expect(deriveCommand("/opt/Claude/CLI", "/opt/Claude/CLI --serve")).toBe("cli");
  });

  test("comm wins when there is no args column at all", () => {
    expect(deriveCommand("/bin/bash", "")).toBe("bash");
  });

  test("lowercases the result", () => {
    expect(deriveCommand("/bin/ZSH", "-zsh")).toBe("zsh");
  });

  test("empty comm + empty args → null", () => {
    expect(deriveCommand("", "")).toBeNull();
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

  // sampleProcesses is async (it drains in-flight OTLP POSTs before resolving),
  // so every call is awaited. platform:"darwin" pins the macOS-shaped psRow
  // fixtures so the suite is host-independent (it would mis-split on a Linux CI).
  const DARWIN = { platform: "darwin" };

  test("emits one host.process.sampled envelope per top-N row", async () => {
    const { emit, envelopes } = recordingEmit();
    const out = await sampleProcesses({
      psLines: psSnapshot,
      readWorkerMap: workerMap,
      topN: 3,
      emit,
      now: () => FIXED_NOW,
      ...DARWIN,
    });
    expect(out.length).toBe(3);
    expect(envelopes.length).toBe(3);
    for (const e of envelopes) {
      expect(e.attributes["event.name"]).toBe(PROCESS_EVENT_SAMPLED);
      expect(e.attributes["event.entity"]).toBe("host");
      expect(e.attributes["event.action"]).toBe("process.sampled");
      expect(e.attributes["event.label"]).toBe(hostname().replace(/\.local$/, ""));
      expect(e.resource["service.name"]).toBe("catalyst.agent");
      expect(e.ts).toBe(FIXED_NOW);
    }
  });

  test("top-N is by RSS desc: chrome(950k) > claude(900k) > worker-root(800k)", async () => {
    const { emit, envelopes } = recordingEmit();
    await sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 3, emit, ...DARWIN });
    const pids = envelopes.map((e) => e.body.payload.pid);
    expect(pids).toEqual([2000, 1200, 1000]);
  });

  test("contract: attributes carry command/cpu/rss; payload carries pid/ppid/args/bg_job_id", async () => {
    const { emit, envelopes } = recordingEmit();
    await sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit, ...DARWIN });
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

  test("direct attribution: the worker root row gets ticket/phase/bg_job_id", async () => {
    const { emit, envelopes } = recordingEmit();
    await sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit, ...DARWIN });
    const root = envelopes.find((e) => e.body.payload.pid === 1000);
    expect(root.attributes["process.ticket"]).toBe("CTL-555");
    expect(root.attributes["process.phase"]).toBe("implement");
    expect(root.body.payload.bg_job_id).toBe("job-9");
  });

  test("via-ancestor attribution: the claude grandchild inherits the worker's ticket", async () => {
    const { emit, envelopes } = recordingEmit();
    await sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit, ...DARWIN });
    const claude = envelopes.find((e) => e.body.payload.pid === 1200);
    expect(claude.attributes["process.ticket"]).toBe("CTL-555");
    expect(claude.attributes["process.phase"]).toBe("implement");
    expect(claude.body.payload.bg_job_id).toBe("job-9");
  });

  test("unattributed process omits ticket/phase attrs and has null bg_job_id", async () => {
    const { emit, envelopes } = recordingEmit();
    await sampleProcesses({ psLines: psSnapshot, readWorkerMap: workerMap, topN: 5, emit, ...DARWIN });
    const chrome = envelopes.find((e) => e.body.payload.pid === 2000);
    expect("process.ticket" in chrome.attributes).toBe(false);
    expect("process.phase" in chrome.attributes).toBe(false);
    expect(chrome.body.payload.bg_job_id).toBeNull();
  });

  test("missing workers dir → empty map → every process unattributed", async () => {
    const { emit, envelopes } = recordingEmit();
    await sampleProcesses({
      psLines: psSnapshot,
      readWorkerMap: () => new Map(), // simulate no workers dir
      topN: 5,
      emit,
      ...DARWIN,
    });
    for (const e of envelopes) {
      expect("process.ticket" in e.attributes).toBe(false);
      expect("process.phase" in e.attributes).toBe(false);
      expect(e.body.payload.bg_job_id).toBeNull();
    }
  });

  test("a throwing psLines seam degrades to [] (never throws)", async () => {
    let out;
    let threw = false;
    try {
      out = await sampleProcesses({
        psLines: () => {
          throw new Error("ps exploded");
        },
        readWorkerMap: () => new Map(),
        emit: () => {},
        ...DARWIN,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(out).toEqual([]);
  });

  test("a throwing readWorkerMap seam degrades to all-unattributed (never throws)", async () => {
    const { emit, envelopes } = recordingEmit();
    let threw = false;
    try {
      await sampleProcesses({
        psLines: psSnapshot,
        readWorkerMap: () => {
          throw new Error("fs exploded");
        },
        topN: 2,
        emit,
        ...DARWIN,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(envelopes.length).toBe(2);
    for (const e of envelopes) expect("process.ticket" in e.attributes).toBe(false);
  });

  test("a throwing emit does not abort the tick (best-effort per row)", async () => {
    let calls = 0;
    const out = await sampleProcesses({
      psLines: psSnapshot,
      readWorkerMap: workerMap,
      topN: 3,
      emit: () => {
        calls++;
        throw new Error("emit boom");
      },
      now: () => FIXED_NOW,
      ...DARWIN,
    });
    // All 3 envelopes were built and emit was attempted for each.
    expect(out.length).toBe(3);
    expect(calls).toBe(3);
  });

  test("drains in-flight OTLP POSTs before resolving (CTL-812: no abandoned POST)", async () => {
    // The emit seam returns a slow promise (an OTLP POST). sampleProcesses must
    // await it before resolving — otherwise the --once path would exit with the
    // POST still in flight. We assert every returned promise has settled by the
    // time sampleProcesses resolves.
    let settled = 0;
    const slowEmit = () =>
      new Promise((resolve) => setTimeout(() => { settled++; resolve(true); }, 5));
    const out = await sampleProcesses({
      psLines: psSnapshot,
      readWorkerMap: workerMap,
      topN: 3,
      emit: slowEmit,
      now: () => FIXED_NOW,
      ...DARWIN,
    });
    expect(out.length).toBe(3);
    // All 3 slow POSTs completed before the tick resolved (not abandoned).
    expect(settled).toBe(3);
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
