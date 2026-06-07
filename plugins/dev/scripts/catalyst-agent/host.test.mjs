// host.test.mjs — CTL-812 Domain 2. The host.metrics sampler.
//
// sampleHost is exercised purely through injected seams (readCpu / readMem /
// readDisk / readLoad / emit) so there is no real /proc, df, vm_stat, or sleep.
// Covers: exact contract attrs, partial-probe failure still emits, pct bounds
// clamped 0..100, rounding (pct 1dp, mb int, gb 1dp, load1 2dp), the put()
// pattern (null probe → attr omitted), and the pure parse helpers against real
// `df -k /` and `vm_stat` output captured on macOS.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test host.test.mjs

import { describe, test, expect } from "bun:test";
import { hostname } from "node:os";
import {
  sampleHost,
  HOST_EVENT_SAMPLED,
  parseDfRoot,
  parseVmStat,
  memUsedBytesFromVmStat,
  cpuTimesTotals,
  cpuBusyPctFromDeltas,
} from "./host.mjs";

// captureEmit — an injected emit that records (name, spec, opts) and returns a
// minimal envelope-like object so sampleHost's return value is still inspectable.
function captureEmit() {
  const calls = [];
  const emit = (name, spec, opts) => {
    calls.push({ name, spec, opts });
    return { name, attributes: { "event.name": name, ...spec.attrs } };
  };
  return { calls, emit };
}

// A full set of healthy probe seams (round-number values so rounding is obvious).
function healthyProbes(overrides = {}) {
  return {
    readCpu: () => ({ cpuPct: 12.34, cpuCount: 10 }),
    readMem: () => ({ usedMb: 8192.6, totalMb: 16384 }),
    readDisk: () => ({ usedGb: 120.45, totalGb: 500 }),
    readLoad: () => 2.345,
    ...overrides,
  };
}

describe("sampleHost — emits one host.metrics.sampled per contract", () => {
  test("emits exactly one event with entity=host and label=hostname", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({ ...healthyProbes(), emit });
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe(HOST_EVENT_SAMPLED);
    expect(calls[0].spec.entity).toBe("host");
    expect(calls[0].spec.label).toBe(hostname());
  });

  test("a custom label overrides the hostname default", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({ ...healthyProbes(), emit, label: "fixture-host" });
    expect(calls[0].spec.label).toBe("fixture-host");
  });

  test("now is threaded through to emit", async () => {
    const { calls, emit } = captureEmit();
    const now = () => "2026-06-07T00:00:00Z";
    await sampleHost({ ...healthyProbes(), emit, now });
    expect(calls[0].opts.now).toBe(now);
  });

  test("carries every contract attr with correct rounding", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({ ...healthyProbes(), emit });
    const a = calls[0].spec.attrs;
    expect(a["host.cpu_pct"]).toBe(12.3); // 1 decimal
    expect(a["host.cpu_count"]).toBe(10); // int
    expect(a["host.load1"]).toBe(2.35); // 2 decimals
    expect(a["host.mem_used_mb"]).toBe(8193); // int (8192.6 → 8193)
    expect(a["host.mem_total_mb"]).toBe(16384); // int
    expect(a["host.mem_used_pct"]).toBe(50.0); // 8192.6/16384*100 → 50.0
    expect(a["host.disk_used_gb"]).toBe(120.5); // 1 decimal (120.45 → 120.5)
    expect(a["host.disk_total_gb"]).toBe(500.0); // 1 decimal
    expect(a["host.disk_used_pct"]).toBe(24.1); // 120.45/500*100 = 24.09 → 24.1
  });
});

describe("sampleHost — partial-probe failure still emits", () => {
  test("a throwing probe omits its attrs; the event still emits with the rest", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({
      ...healthyProbes({
        readDisk: () => {
          throw new Error("df not found");
        },
      }),
      emit,
    });
    expect(calls.length).toBe(1);
    const a = calls[0].spec.attrs;
    // disk probe threw → all three disk attrs are null (dropped downstream).
    expect(a["host.disk_used_gb"]).toBe(null);
    expect(a["host.disk_total_gb"]).toBe(null);
    expect(a["host.disk_used_pct"]).toBe(null);
    // the others are unaffected.
    expect(a["host.cpu_pct"]).toBe(12.3);
    expect(a["host.mem_used_mb"]).toBe(8193);
  });

  test("a null-returning probe omits only its attrs", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({
      ...healthyProbes({ readCpu: () => ({ cpuPct: null, cpuCount: null }) }),
      emit,
    });
    const a = calls[0].spec.attrs;
    expect(a["host.cpu_pct"]).toBe(null);
    expect(a["host.cpu_count"]).toBe(null);
    expect(a["host.load1"]).toBe(2.35); // still present
  });

  test("a rejected async probe is swallowed and the event still emits", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({
      ...healthyProbes({ readMem: async () => Promise.reject(new Error("boom")) }),
      emit,
    });
    expect(calls.length).toBe(1);
    const a = calls[0].spec.attrs;
    expect(a["host.mem_used_mb"]).toBe(null);
    expect(a["host.mem_total_mb"]).toBe(null);
    expect(a["host.mem_used_pct"]).toBe(null);
  });

  test("an async probe value is awaited (not emitted as a Promise)", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({
      ...healthyProbes({ readCpu: async () => ({ cpuPct: 50, cpuCount: 8 }) }),
      emit,
    });
    expect(calls[0].spec.attrs["host.cpu_pct"]).toBe(50);
    expect(calls[0].spec.attrs["host.cpu_count"]).toBe(8);
  });

  test("all probes failing still emits an event (all value attrs null)", async () => {
    const { calls, emit } = captureEmit();
    const boom = () => {
      throw new Error("nope");
    };
    await sampleHost({ readCpu: boom, readMem: boom, readDisk: boom, readLoad: boom, emit });
    expect(calls.length).toBe(1);
    const a = calls[0].spec.attrs;
    for (const k of Object.keys(a)) expect(a[k]).toBe(null);
  });
});

describe("sampleHost — pct bounds clamped to 0..100", () => {
  test("cpu_pct above 100 is clamped to 100", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({ ...healthyProbes({ readCpu: () => ({ cpuPct: 150, cpuCount: 4 }) }), emit });
    expect(calls[0].spec.attrs["host.cpu_pct"]).toBe(100);
  });

  test("cpu_pct below 0 is clamped to 0", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({ ...healthyProbes({ readCpu: () => ({ cpuPct: -5, cpuCount: 4 }) }), emit });
    expect(calls[0].spec.attrs["host.cpu_pct"]).toBe(0);
  });

  test("derived mem_used_pct over 100 (used > total) is clamped to 100", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({
      ...healthyProbes({ readMem: () => ({ usedMb: 20000, totalMb: 16384 }) }),
      emit,
    });
    expect(calls[0].spec.attrs["host.mem_used_pct"]).toBe(100);
  });

  test("a zero/absent denominator yields a null pct (no div-by-zero / NaN)", async () => {
    const { calls, emit } = captureEmit();
    await sampleHost({
      ...healthyProbes({
        readMem: () => ({ usedMb: 100, totalMb: 0 }),
        readDisk: () => ({ usedGb: 5, totalGb: null }),
      }),
      emit,
    });
    expect(calls[0].spec.attrs["host.mem_used_pct"]).toBe(null);
    expect(calls[0].spec.attrs["host.disk_used_pct"]).toBe(null);
  });
});

describe("parseDfRoot — real `df -k /` fixtures", () => {
  // Captured on macOS (note the inode columns iused/ifree/%iused after Capacity).
  const MACOS = `Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1   971350180  16324544 186926344     9%  458116 1869263440    0%   /`;

  // Linux `df -k /` shape (no inode columns).
  const LINUX = `Filesystem     1K-blocks     Used Available Use% Mounted on
/dev/nvme0n1p2 102400000 51200000  46137344  53% /`;

  test("parses the macOS row by leading column position (total, used)", () => {
    expect(parseDfRoot(MACOS)).toEqual({ totalKb: 971350180, usedKb: 16324544 });
  });

  test("parses the Linux row identically (same leading positions)", () => {
    expect(parseDfRoot(LINUX)).toEqual({ totalKb: 102400000, usedKb: 51200000 });
  });

  test("returns null for empty / header-only / unparseable input", () => {
    expect(parseDfRoot("")).toBe(null);
    expect(parseDfRoot("Filesystem 1024-blocks Used Available Capacity Mounted on")).toBe(null);
    expect(parseDfRoot("garbage line with no numbers here\nstill garbage")).toBe(null);
  });

  test("the parsed macOS fixture converts to the expected GB (1 decimal)", async () => {
    const { calls, emit } = captureEmit();
    // Wire the real macOS df through the default disk path's parser via a custom
    // readDisk that mirrors defaultReadDisk's KB→GB math (1024*1024 KB per GB).
    const parsed = parseDfRoot(MACOS);
    const KB_PER_GB = 1024 * 1024;
    await sampleHost({
      ...healthyProbes({
        readDisk: () => ({ usedGb: parsed.usedKb / KB_PER_GB, totalGb: parsed.totalKb / KB_PER_GB }),
      }),
      emit,
    });
    const a = calls[0].spec.attrs;
    expect(a["host.disk_total_gb"]).toBe(926.4); // 971350180/1048576 = 926.36 → 926.4
    expect(a["host.disk_used_gb"]).toBe(15.6); // 16324544/1048576 = 15.57 → 15.6
    expect(a["host.disk_used_pct"]).toBe(1.7); // 16324544/971350180*100 = 1.68 → 1.7
  });
});

describe("parseVmStat / memUsedBytesFromVmStat — real macOS vm_stat fixture", () => {
  // Captured on macOS (page size 16384). Trimmed to the buckets we use plus a
  // couple of others to prove the line parser is tolerant of extra rows.
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              112322.
Pages active:                           1116505.
Pages inactive:                         1108757.
Pages speculative:                         6674.
Pages wired down:                        453208.
Pages purgeable:                          20353.
Pages occupied by compressor:           1339877.
File-backed pages:                       739653.`;

  test("parseVmStat extracts the page size and the named page counts", () => {
    const parsed = parseVmStat(VM_STAT);
    expect(parsed.pageSize).toBe(16384);
    expect(parsed.pages["pages active"]).toBe(1116505);
    expect(parsed.pages["pages wired down"]).toBe(453208);
    expect(parsed.pages["pages occupied by compressor"]).toBe(1339877);
  });

  test("memUsedBytesFromVmStat = (active + wired + compressed) * pageSize", () => {
    const parsed = parseVmStat(VM_STAT);
    const expected = (1116505 + 453208 + 1339877) * 16384;
    expect(memUsedBytesFromVmStat(parsed)).toBe(expected);
  });

  test("parseVmStat returns null when the page size header is absent", () => {
    expect(parseVmStat("Pages active: 100.")).toBe(null);
    expect(parseVmStat("")).toBe(null);
  });

  test("memUsedBytesFromVmStat returns null when a required bucket is missing", () => {
    const parsed = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages active:                           1000.`); // no wired / compressor
    expect(memUsedBytesFromVmStat(parsed)).toBe(null);
    expect(memUsedBytesFromVmStat(null)).toBe(null);
  });
});

describe("cpu two-sample delta helpers (pure)", () => {
  const snap = (idle, user, sys) => [{ times: { idle, user, sys, nice: 0, irq: 0 } }];

  test("cpuTimesTotals sums idle and total across cores", () => {
    const totals = cpuTimesTotals([
      { times: { idle: 10, user: 5, sys: 3, nice: 1, irq: 1 } },
      { times: { idle: 20, user: 4, sys: 2, nice: 0, irq: 0 } },
    ]);
    expect(totals.idle).toBe(30);
    expect(totals.total).toBe(10 + 5 + 3 + 1 + 1 + 20 + 4 + 2);
  });

  test("cpuBusyPctFromDeltas: 50% busy when half the delta-ticks are non-idle", () => {
    const a = cpuTimesTotals(snap(100, 0, 0)); // idle 100, total 100
    const b = cpuTimesTotals(snap(150, 25, 25)); // idle 150, total 200 → Δidle 50, Δtotal 100
    expect(cpuBusyPctFromDeltas(a, b)).toBe(50);
  });

  test("cpuBusyPctFromDeltas returns null when no time elapsed (Δtotal <= 0)", () => {
    const a = cpuTimesTotals(snap(100, 0, 0));
    expect(cpuBusyPctFromDeltas(a, a)).toBe(null);
  });

  test("cpuBusyPctFromDeltas clamps a fully-busy window to 100", () => {
    const a = cpuTimesTotals(snap(100, 0, 0));
    const b = cpuTimesTotals(snap(100, 50, 50)); // Δidle 0, Δtotal 100 → 100%
    expect(cpuBusyPctFromDeltas(a, b)).toBe(100);
  });
});
