// host.mjs — CTL-812 Domain 2. The host.metrics sampler.
//
// sampleHost() reads four host probes (cpu, mem, disk, load) and emits exactly
// ONE host.metrics.sampled envelope per the telemetry contract. Each probe is
// an injected seam (readCpu / readMem / readDisk / readLoad) so tick() is fully
// unit-testable with no real /proc, df, vm_stat, or two-sample sleep. The
// defaults cover macOS + Linux and NEVER throw — a failed probe returns null and
// the corresponding attribute is simply omitted (the put() pattern in
// buildAgentEnvelope), so the event still emits with whatever is available.
//
// SELF-CONTAINED: zero npm deps, node:* builtins only; runs under node>=18 and
// bun. The standalone agent does NOT import from execution-core.
//
// Contract attrs (host.metrics.sampled, entity=host, event.label=hostname):
//   host.cpu_pct       1 decimal, clamped 0..100
//   host.cpu_count     integer (os.cpus().length)
//   host.load1         os.loadavg()[0], 2 decimals
//   host.mem_used_mb   integer
//   host.mem_total_mb  integer
//   host.mem_used_pct  1 decimal, clamped 0..100
//   host.disk_used_gb  1 decimal
//   host.disk_total_gb 1 decimal
//   host.disk_used_pct 1 decimal, clamped 0..100

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, loadavg, totalmem, freemem, hostname } from "node:os";
import { buildAgentEnvelope, emitEnvelope } from "./emit.mjs";
import { readAgentConfig, log } from "./config.mjs";

export const HOST_EVENT_SAMPLED = "host.metrics.sampled";

const BYTES_PER_MB = 1024 * 1024;
const KB_PER_GB = 1024 * 1024; // KB → GB (df reports 1024-byte blocks)
// Default two-sample window for the CPU-busy delta. 500ms gives a stable read
// without meaningfully delaying a once-every-5-min launchd tick. Injectable.
const DEFAULT_CPU_WINDOW_MS = 500;

// --- rounding / clamping helpers (pure) ---

// round1 / round2 — round to 1 / 2 decimals, passing null/non-finite through so
// a missing probe stays null (and is dropped by the put() pattern downstream).
function round1(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}
function round2(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}
function roundInt(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n);
}
// clampPct — clamp a percentage into [0, 100]; null/non-finite passes through.
function clampPct(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

// --- sleep seam (await-able, no foreground `sleep` shell) ---
function realSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- default probe: CPU ---
// cpuTimesTotals — sum the per-core { idle, total } from an os.cpus() snapshot.
// Pure so the two-sample delta can be unit-tested without a real clock.
export function cpuTimesTotals(snapshot) {
  let idle = 0;
  let total = 0;
  for (const c of snapshot ?? []) {
    const t = c?.times ?? {};
    idle += t.idle ?? 0;
    total += (t.user ?? 0) + (t.nice ?? 0) + (t.sys ?? 0) + (t.idle ?? 0) + (t.irq ?? 0);
  }
  return { idle, total };
}

// cpuBusyPctFromDeltas — busy% = 100 * (1 - Δidle/Δtotal) from two totals.
// Returns null when Δtotal <= 0 (no elapsed ticks → undefined utilization).
export function cpuBusyPctFromDeltas(a, b) {
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (!(dTotal > 0)) return null;
  return clampPct(100 * (1 - dIdle / dTotal));
}

// defaultReadCpu — two-sample os.cpus() busy% over sampleWindowMs (cross-platform).
// On Linux a /proc/stat delta is marginally cheaper, but the os.cpus() delta is
// portable and already accurate, so it is the single default path. Never throws.
//
// `snapshot` and `sleep` are injectable so the default reader itself is testable
// without a real delay.
async function defaultReadCpu({
  sampleWindowMs = DEFAULT_CPU_WINDOW_MS,
  snapshot = cpus,
  sleep = realSleep,
} = {}) {
  try {
    const a = cpuTimesTotals(snapshot());
    await sleep(sampleWindowMs);
    const b = cpuTimesTotals(snapshot());
    return { cpuPct: cpuBusyPctFromDeltas(a, b), cpuCount: snapshot().length };
  } catch {
    return { cpuPct: null, cpuCount: null };
  }
}

// --- default probe: memory ---
// PAGE-SIZE / "used" choice (macOS): os.freemem() on Darwin reports only the
// truly free list and counts the large inactive/compressible pool as "used",
// which wildly overstates pressure. We instead derive used from vm_stat's
// active + wired + compressed pages (the genuinely resident, non-reclaimable
// working set) × page size — the same definition Activity Monitor's "Memory
// Used" approximates. os.totalmem() is the denominator. If vm_stat is
// unavailable or unparseable we fall back to os.totalmem()/freemem().

// parseVmStat — parse `vm_stat` output into { pageSize, pages:{...} }. The header
// line "page size of N bytes" gives the page size; each "Key: N." line yields a
// page count. Returns null if the page size cannot be found. Pure / never throws.
export function parseVmStat(text) {
  if (!text) return null;
  const sizeMatch = /page size of (\d+) bytes/.exec(text);
  if (!sizeMatch) return null;
  const pageSize = Number(sizeMatch[1]);
  const pages = {};
  for (const line of String(text).split("\n")) {
    const m = /^(.*?):\s+(\d+)\.?\s*$/.exec(line);
    if (m) pages[m[1].trim().toLowerCase()] = Number(m[2]);
  }
  return { pageSize, pages };
}

// memUsedBytesFromVmStat — used = (active + wired down + occupied by compressor)
// × pageSize. Returns null if any required bucket is missing.
export function memUsedBytesFromVmStat(parsed) {
  if (!parsed) return null;
  const p = parsed.pages;
  const active = p["pages active"];
  const wired = p["pages wired down"];
  const compressed = p["pages occupied by compressor"];
  if (active == null || wired == null || compressed == null) return null;
  return (active + wired + compressed) * parsed.pageSize;
}

// defaultReadMem — { usedMb, totalMb }. macOS prefers the vm_stat-based used
// (documented above) with an os.* fallback; Linux/other uses os.totalmem -
// os.freemem directly. Never throws.
function defaultReadMem({
  vmStat = () => execFileSync("vm_stat", { encoding: "utf8" }),
} = {}) {
  try {
    const totalBytes = totalmem();
    let usedBytes = null;
    if (process.platform === "darwin") {
      try {
        usedBytes = memUsedBytesFromVmStat(parseVmStat(vmStat()));
      } catch {
        usedBytes = null;
      }
    }
    // Fallback (non-darwin, or vm_stat unavailable): total - free.
    if (usedBytes == null) usedBytes = totalBytes - freemem();
    return { usedMb: usedBytes / BYTES_PER_MB, totalMb: totalBytes / BYTES_PER_MB };
  } catch {
    return { usedMb: null, totalMb: null };
  }
}

// --- default probe: disk ---
// parseDfRoot — parse `df -k /` output → { usedKb, totalKb }. macOS df adds inode
// columns (iused ifree %iused) after Capacity and a two-word "Mounted on" header,
// so we index from the START of the data row: field[1]=1024-blocks (total),
// field[2]=Used. Linux `df -k /` is [fs, 1K-blocks, used, avail, use%, mount] —
// the same positions. A device path with embedded spaces is not expected for /.
// Returns null if the row cannot be parsed. Pure / never throws.
export function parseDfRoot(text) {
  if (!text) return null;
  const lines = String(text).trim().split("\n");
  if (lines.length < 2) return null;
  // Last non-empty line is the data row (header is first).
  const row = lines[lines.length - 1].trim().split(/\s+/);
  const totalKb = Number(row[1]);
  const usedKb = Number(row[2]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) return null;
  return { usedKb, totalKb };
}

// defaultReadDisk — { usedGb, totalGb } for the root filesystem via `df -k /`.
// Never throws.
function defaultReadDisk({
  df = () => execFileSync("df", ["-k", "/"], { encoding: "utf8" }),
} = {}) {
  try {
    const parsed = parseDfRoot(df());
    if (!parsed) return { usedGb: null, totalGb: null };
    return { usedGb: parsed.usedKb / KB_PER_GB, totalGb: parsed.totalKb / KB_PER_GB };
  } catch {
    return { usedGb: null, totalGb: null };
  }
}

// --- default probe: load ---
// defaultReadLoad — 1-minute load average. os.loadavg() returns [0,0,0] on
// platforms without load tracking (e.g. some Windows), which is a legitimate 0
// here. Never throws.
function defaultReadLoad() {
  try {
    return loadavg()[0];
  } catch {
    return null;
  }
}

/**
 * sampleHost — read the four host probes and emit ONE host.metrics.sampled
 * envelope. Every probe is injected (defaults provided) so the function is fully
 * unit-testable with no real I/O. A probe that fails / returns null simply omits
 * its attribute(s); the event still emits with whatever is available.
 *
 * @param {object}  [opts]
 * @param {Function} [opts.readCpu]  async/ sync → { cpuPct, cpuCount }
 * @param {Function} [opts.readMem]  → { usedMb, totalMb }
 * @param {Function} [opts.readDisk] → { usedGb, totalGb }
 * @param {Function} [opts.readLoad] → number (load1) | null
 * @param {Function} [opts.emit]     (name, spec, opts) → emit the envelope
 * @param {Function} [opts.now]      injectable ISO-timestamp fn (passed to emit)
 * @param {string}   [opts.label]    event.label override (defaults to hostname())
 * @returns {Promise<object>} the emitted envelope (also useful for assertions)
 */
export async function sampleHost({
  readCpu = defaultReadCpu,
  readMem = defaultReadMem,
  readDisk = defaultReadDisk,
  readLoad = defaultReadLoad,
  emit = defaultEmit,
  now,
  label = hostname(),
} = {}) {
  // Read every probe defensively — one throwing probe must not sink the others
  // or the whole event. `await` is a no-op on a sync return value.
  const cpu = (await safe(() => readCpu())) ?? {};
  const mem = (await safe(() => readMem())) ?? {};
  const disk = (await safe(() => readDisk())) ?? {};
  const load1 = await safe(() => readLoad());

  // mem_used_pct / disk_used_pct are derived only when both numerator and a
  // positive denominator are present (avoid 0/0 → NaN and div-by-zero).
  const memUsedPct =
    isPos(mem.totalMb) && mem.usedMb != null ? (mem.usedMb / mem.totalMb) * 100 : null;
  const diskUsedPct =
    isPos(disk.totalGb) && disk.usedGb != null ? (disk.usedGb / disk.totalGb) * 100 : null;

  const attrs = {
    "host.cpu_pct": round1(clampPct(cpu.cpuPct)),
    "host.cpu_count": roundInt(cpu.cpuCount),
    "host.load1": round2(load1),
    "host.mem_used_mb": roundInt(mem.usedMb),
    "host.mem_total_mb": roundInt(mem.totalMb),
    "host.mem_used_pct": round1(clampPct(memUsedPct)),
    "host.disk_used_gb": round1(disk.usedGb),
    "host.disk_total_gb": round1(disk.totalGb),
    "host.disk_used_pct": round1(clampPct(diskUsedPct)),
  };

  // `await` normalizes both emit seams: the default async defaultEmit (which
  // awaits its own OTLP POST) and the sync makeBuilderEmit (which returns the
  // envelope synchronously and routes the POST into runOnce's drain).
  return await emit(HOST_EVENT_SAMPLED, { entity: "host", label, attrs }, { now });
}

// defaultEmit — build the envelope and route it through the configured
// transport(s) (eventlog / otlp / both) via the shared emitEnvelope() helper.
// Kept as the sampler's default so a bare sampleHost() call writes telemetry;
// tests inject a capturing emit instead. Never throws, and returns the envelope
// so the caller can inspect it. The OTLP POST promise (otlp/both mode) is awaited
// here so a bare sampleHost() never resolves with a request still in flight; in
// the --once importer path the emit seam is makeBuilderEmit instead (which routes
// the POST into runOnce's drain), so this default is the bare-call safety net.
async function defaultEmit(name, spec, opts) {
  const envelope = buildAgentEnvelope(name, spec, opts);
  try {
    await emitEnvelope(envelope, readAgentConfig());
  } catch (err) {
    log.warn({ err: err?.message }, "host: emit failed");
  }
  return envelope;
}

// isPos — true only for a finite number strictly greater than 0.
function isPos(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

// safe — run fn, swallowing any throw to undefined. Awaits the result so both
// sync and async (Promise-returning) probes are handled uniformly; a rejected
// promise is also swallowed.
async function safe(fn) {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
