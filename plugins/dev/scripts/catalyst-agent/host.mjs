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
//   host.disk_avail_gb 1 decimal                                   (CTL-1227)
//   host.disk_free_pct 1 decimal, clamped 0..100                   (CTL-1227)
//   host.worktree_used_gb 1 decimal — LOGICAL (du, APFS-clone-inflated)  (CTL-1227)
//   host.worktree_count   integer                                 (CTL-1227)
//
// CTL-1227: sampleHost ALSO emits a semconv-conformant OTLP METRIC set (bytes /
// ratios) to the collector's metrics pipeline (/v1/metrics → Prometheus) via
// buildHostMetrics(): system.cpu.utilization / .load_average.1m / .logical.count,
// system.memory.usage|utilization, system.filesystem.usage|utilization|limit
// (state + system.device/mountpoint), hw.temperature (Linux),
// catalyst.host.thermal.speed_limit (macOS pmset), and the LOGICAL worktree gauges
// catalyst.worktree.disk.usage_logical / .count. The legacy event is kept for
// dashboard continuity; the metrics are the canonical, physically-accurate source
// (worktree du is clone-inflated — use system.filesystem.* for real disk pressure).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { cpus, loadavg, totalmem, freemem, homedir } from "node:os";
import { shortHostname } from "./emit.mjs";
import { buildAgentEnvelope, emitEnvelope, otlpMetric, emitMetrics } from "./emit.mjs";
import { readAgentConfig, log } from "./config.mjs";

export const HOST_EVENT_SAMPLED = "host.metrics.sampled";

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;
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
  // CTL-1227: also surface avail (col 4, same index on macOS + Linux `df -k`) plus
  // the device (col 1) and mountpoint (last col) for the semconv filesystem
  // attributes (system.device / system.filesystem.mountpoint). availKb is null
  // when unparseable; device/mountpoint are best-effort strings.
  const availKb = Number(row[3]);
  return {
    usedKb,
    totalKb,
    availKb: Number.isFinite(availKb) ? availKb : null,
    device: row[0] || null,
    mountpoint: row[row.length - 1] || null,
  };
}

// defaultReadDisk — { usedGb, totalGb } for the data filesystem via `df -k`.
//
// CTL-812 VOLUME CHOICE: on macOS, `/` is the SEALED APFS SYSTEM SNAPSHOT — a
// few GB of OS image on a ~1TB container, so `df -k /` reads ~1-2% "used" while
// the machine is actually 75%+ full. User data lives on the Data volume
// (`/System/Volumes/Data`), which shares the container and reports the real
// usage. Probe the Data volume on darwin (falling back to `/` when it's absent,
// e.g. non-APFS or a future layout change); Linux keeps `/`.
// Never throws. Exported for the volume-selection tests (df + platform injectable).
export function defaultReadDisk({
  df = (path) => execFileSync("df", ["-k", path], { encoding: "utf8" }),
  platform = process.platform,
} = {}) {
  const probe = (path) => {
    const parsed = parseDfRoot(df(path));
    if (!parsed) return null;
    // GB for the legacy event; raw bytes + device/mountpoint for semconv metrics.
    return {
      usedGb: parsed.usedKb / KB_PER_GB,
      totalGb: parsed.totalKb / KB_PER_GB,
      availGb: parsed.availKb == null ? null : parsed.availKb / KB_PER_GB,
      usedBytes: parsed.usedKb * 1024,
      totalBytes: parsed.totalKb * 1024,
      availBytes: parsed.availKb == null ? null : parsed.availKb * 1024,
      device: parsed.device,
      mountpoint: parsed.mountpoint,
    };
  };
  try {
    if (platform === "darwin") {
      try {
        const data = probe("/System/Volumes/Data");
        if (data) return data;
      } catch {
        /* Data volume missing/unreadable — fall through to the root probe */
      }
    }
    return probe("/") ?? { usedGb: null, totalGb: null };
  } catch {
    return { usedGb: null, totalGb: null };
  }
}

// --- default probe: worktree directory footprint (CTL-1227) ---
// defaultReadWorktree — disk used by ~/catalyst/wt (the per-ticket worktree tree)
// plus a count of leaf worktree dirs (wt/<project>/<ticket>). `du -sk` is one
// kilobyte total; the count is a cheap two-level readdir. Both are injectable and
// NEVER throw — a slow/absent dir returns nulls, so the metric is simply omitted.
// du can take a few seconds on a multi-GB tree, which is fine for the 5-min
// launchd `--once` tick; bounded by a 60s timeout so a pathological FS can't hang.
export function defaultReadWorktree({
  catalystDir = process.env.CATALYST_DIR || `${homedir()}/catalyst`,
  du = (p) => execFileSync("du", ["-sk", p], { encoding: "utf8", timeout: 60_000 }),
  listDirs = (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()),
} = {}) {
  const wtDir = `${catalystDir}/wt`;
  let usedBytes = null;
  let count = null;
  try {
    const kb = Number(String(du(wtDir)).trim().split(/\s+/)[0]);
    if (Number.isFinite(kb)) usedBytes = kb * 1024;
  } catch {
    /* du failed (missing dir / timeout) — leave usedBytes null */
  }
  try {
    let n = 0;
    for (const proj of listDirs(wtDir)) n += listDirs(`${wtDir}/${proj.name}`).length;
    count = n;
  } catch {
    /* wt dir absent / unreadable — leave count null */
  }
  return { usedBytes, count };
}

// --- default probe: thermal (best-effort, NO sudo; CTL-1227) ---
// The minis are always-on Apple Silicon, so overheating matters. There is no
// clean no-sudo CPU TEMPERATURE on macOS, but `pmset -g therm` exposes
// CPU_Speed_Limit (% of full speed; < 100 ⇒ the OS is thermally throttling) — the
// usable no-sudo overheating signal. Linux exposes real temps under
// /sys/class/thermal/thermal_zone*/temp (millidegree C). Returns whichever signal
// the platform offers; the other stays null (and its metric is omitted). Never
// throws — both probes are injected so this is fully unit-testable.
export function defaultReadThermal({
  platform = process.platform,
  readZones = defaultReadThermalZones,
  pmset = () => execFileSync("pmset", ["-g", "therm"], { encoding: "utf8", timeout: 5_000 }),
} = {}) {
  let temperatureCel = null;
  let speedLimitPct = null;
  try {
    if (platform === "linux") {
      const temps = readZones();
      if (Array.isArray(temps) && temps.length) {
        temperatureCel = temps.reduce((a, b) => a + b, 0) / temps.length;
      }
    } else if (platform === "darwin") {
      const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(pmset());
      if (m) speedLimitPct = Number(m[1]);
    }
  } catch {
    /* best-effort — leave nulls */
  }
  return { temperatureCel, speedLimitPct };
}

// defaultReadThermalZones — mean-able array of Celsius temps from sysfs. Each
// /sys/class/thermal/thermal_zone*/temp is millidegree C. Never throws.
function defaultReadThermalZones() {
  const out = [];
  try {
    for (const name of readdirSync("/sys/class/thermal")) {
      if (!name.startsWith("thermal_zone")) continue;
      try {
        const milli = Number(String(readFileSync(`/sys/class/thermal/${name}/temp`, "utf8")).trim());
        if (Number.isFinite(milli)) out.push(milli / 1000);
      } catch {
        /* skip an unreadable zone */
      }
    }
  } catch {
    /* no sysfs thermal — return [] */
  }
  return out;
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

// --- semconv metric builder (CTL-1227) ---
// ratioOf / sub — null-safe helpers for derived metric values.
function ratioOf(num, den) {
  return isPos(den) && num != null && Number.isFinite(num) ? num / den : null;
}
function sub(a, b) {
  return a != null && b != null && Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

/**
 * buildHostMetrics — map raw host readings to an array of OpenTelemetry
 * SEMCONV metrics (https://opentelemetry.io/docs/specs/semconv/system/). Pure +
 * fully unit-testable. Values are BYTES / RATIOS per semconv (not the GB/percent
 * the legacy host.metrics.sampled event carries). A metric whose value is null is
 * dropped (otlpMetric returns null → filtered), so a partial read still emits.
 *
 * @param {object} r  { cpuPct, load1, mem:{usedBytes,totalBytes},
 *                      disk:{usedBytes,totalBytes,availBytes,device,mountpoint,type},
 *                      worktree:{usedBytes,count} }
 * @param {string|number} nowNs  data-point timeUnixNano
 * @returns {object[]} OTLP metric objects (already null-filtered)
 */
export function buildHostMetrics(r = {}, nowNs) {
  const t = String(nowNs ?? "");
  const mem = r.mem ?? {};
  const disk = r.disk ?? {};
  const wt = r.worktree ?? {};
  const fsAttrs = {
    "system.device": disk.device,
    "system.filesystem.mountpoint": disk.mountpoint,
    "system.filesystem.type": disk.type,
  };
  const metrics = [
    otlpMetric({
      name: "system.cpu.utilization",
      unit: "1",
      description: "Total CPU utilization as a fraction (0..1).",
      kind: "gauge",
      points: [{ value: ratioOf(r.cpuPct, 100), timeUnixNano: t }],
    }),
    otlpMetric({
      name: "system.cpu.load_average.1m",
      unit: "1",
      description: "1-minute load average.",
      kind: "gauge",
      points: [{ value: r.load1, timeUnixNano: t }],
    }),
    otlpMetric({
      name: "system.cpu.logical.count",
      unit: "{cpu}",
      description: "Number of logical CPUs.",
      kind: "sum",
      points: [{ value: r.cpuCount, timeUnixNano: t }],
    }),
    otlpMetric({
      name: "system.memory.usage",
      unit: "By",
      description: "Memory bytes by state.",
      kind: "sum",
      points: [
        { value: mem.usedBytes, attrs: { "system.memory.state": "used" }, timeUnixNano: t },
        { value: sub(mem.totalBytes, mem.usedBytes), attrs: { "system.memory.state": "free" }, timeUnixNano: t },
      ],
    }),
    otlpMetric({
      name: "system.memory.utilization",
      unit: "1",
      description: "Memory used as a fraction of total (0..1).",
      kind: "gauge",
      points: [{ value: ratioOf(mem.usedBytes, mem.totalBytes), attrs: { "system.memory.state": "used" }, timeUnixNano: t }],
    }),
    otlpMetric({
      name: "system.filesystem.usage",
      unit: "By",
      description: "Filesystem bytes by state.",
      kind: "sum",
      points: [
        { value: disk.usedBytes, attrs: { ...fsAttrs, "system.filesystem.state": "used" }, timeUnixNano: t },
        { value: disk.availBytes, attrs: { ...fsAttrs, "system.filesystem.state": "free" }, timeUnixNano: t },
      ],
    }),
    otlpMetric({
      name: "system.filesystem.utilization",
      unit: "1",
      description: "Fraction of filesystem bytes used (0..1).",
      kind: "gauge",
      points: [{ value: ratioOf(disk.usedBytes, disk.totalBytes), attrs: { ...fsAttrs, "system.filesystem.state": "used" }, timeUnixNano: t }],
    }),
    otlpMetric({
      name: "system.filesystem.limit",
      unit: "By",
      description: "Total filesystem capacity in bytes.",
      kind: "sum",
      points: [{ value: disk.totalBytes, attrs: fsAttrs, timeUnixNano: t }],
    }),
    // Custom (semconv has no directory-size metric): the per-ticket worktree tree.
    // IMPORTANT: this is LOGICAL (du) size and is APFS clone-inflated — bun installs
    // node_modules via clonefile(), so du overstates PHYSICAL disk by ~10-30×. For
    // real disk pressure use system.filesystem.* above; this gauge tracks logical
    // growth / relative trend only. (CTL-1227 research, verified on laptop + mini.)
    otlpMetric({
      name: "catalyst.worktree.disk.usage_logical",
      unit: "By",
      description:
        "Logical (du) bytes of ~/catalyst/wt. APFS clone-inflated — overstates physical disk; use system.filesystem.* for physical pressure.",
      kind: "gauge",
      points: [{ value: wt.usedBytes, attrs: { "catalyst.directory": "wt", "catalyst.measurement": "logical_du" }, timeUnixNano: t }],
    }),
    otlpMetric({
      name: "catalyst.worktree.count",
      unit: "{worktree}",
      description: "Number of per-ticket worktree directories under ~/catalyst/wt.",
      kind: "gauge",
      points: [{ value: wt.count, attrs: { "catalyst.directory": "wt" }, timeUnixNano: t }],
    }),
    // Thermal (best-effort, platform-specific). hw.temperature is the experimental
    // semconv hardware metric (Celsius); the macOS speed-limit is a catalyst.* custom.
    otlpMetric({
      name: "hw.temperature",
      unit: "Cel",
      description: "Mean CPU/thermal-zone temperature (Linux; Celsius).",
      kind: "gauge",
      points: [{ value: (r.thermal ?? {}).temperatureCel, attrs: { "hw.type": "cpu" }, timeUnixNano: t }],
    }),
    otlpMetric({
      name: "catalyst.host.thermal.speed_limit",
      unit: "1",
      description:
        "macOS pmset CPU_Speed_Limit as a fraction (1.0 = full speed; < 1.0 = thermal throttling).",
      kind: "gauge",
      points: [{ value: ratioOf((r.thermal ?? {}).speedLimitPct, 100), timeUnixNano: t }],
    }),
  ];
  return metrics.filter(Boolean);
}

/**
 * sampleHost — read the host probes and emit ONE host.metrics.sampled envelope
 * (legacy, GB/percent) AND — when a metrics emitter is wired — the semconv OTLP
 * metric set (bytes/ratio; CTL-1227). Every probe is injected (defaults provided)
 * so the function is fully unit-testable with no real I/O. A probe that fails /
 * returns null simply omits its attribute(s)/metric; the event still emits.
 *
 * @param {object}  [opts]
 * @param {Function} [opts.readCpu]  async/ sync → { cpuPct, cpuCount }
 * @param {Function} [opts.readMem]  → { usedMb, totalMb }
 * @param {Function} [opts.readDisk] → { usedGb, totalGb, availGb, usedBytes, totalBytes, availBytes, device, mountpoint }
 * @param {Function} [opts.readLoad] → number (load1) | null
 * @param {Function} [opts.readWorktree] → { usedBytes, count }
 * @param {Function} [opts.emit]     (name, spec, opts) → emit the envelope
 * @param {Function} [opts.emitMetricsFn] (metrics[]) → emit the OTLP metric batch (default: config-aware)
 * @param {Function} [opts.now]      injectable ISO-timestamp fn (passed to emit)
 * @param {Function} [opts.nowMs]    injectable epoch-ms fn for the metric timeUnixNano
 * @param {string}   [opts.label]    event.label override (defaults to shortHostname())
 * @returns {Promise<object>} the emitted envelope (also useful for assertions)
 */
export async function sampleHost({
  readCpu = defaultReadCpu,
  readMem = defaultReadMem,
  readDisk = defaultReadDisk,
  readLoad = defaultReadLoad,
  readWorktree = defaultReadWorktree,
  emit = defaultEmit,
  emitMetricsFn = defaultEmitMetrics,
  now,
  nowMs = () => Date.now(),
  label = shortHostname(),
} = {}) {
  // Read every probe defensively — one throwing probe must not sink the others
  // or the whole event. `await` is a no-op on a sync return value.
  const cpu = (await safe(() => readCpu())) ?? {};
  const mem = (await safe(() => readMem())) ?? {};
  const disk = (await safe(() => readDisk())) ?? {};
  const load1 = await safe(() => readLoad());
  const worktree = (await safe(() => readWorktree())) ?? {};

  // mem_used_pct / disk_used_pct are derived only when both numerator and a
  // positive denominator are present (avoid 0/0 → NaN and div-by-zero).
  const memUsedPct =
    isPos(mem.totalMb) && mem.usedMb != null ? (mem.usedMb / mem.totalMb) * 100 : null;
  const diskUsedPct =
    isPos(disk.totalGb) && disk.usedGb != null ? (disk.usedGb / disk.totalGb) * 100 : null;
  // free% prefers the avail probe (matches what `df` calls Available) and falls
  // back to 100 - used% when avail is unavailable.
  const diskFreePct =
    isPos(disk.totalGb) && disk.availGb != null
      ? (disk.availGb / disk.totalGb) * 100
      : diskUsedPct != null
        ? 100 - diskUsedPct
        : null;

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
    // CTL-1227 additions on the legacy event (dashboard convenience; the canonical
    // values are the semconv metrics below).
    "host.disk_avail_gb": round1(disk.availGb),
    "host.disk_free_pct": round1(clampPct(diskFreePct)),
    "host.worktree_used_gb": round1(worktree.usedBytes == null ? null : worktree.usedBytes / BYTES_PER_GB),
    "host.worktree_count": roundInt(worktree.count),
  };

  // CTL-1227: emit the semconv OTLP metric set (bytes/ratio) in addition to the
  // legacy event. Bytes come from the probes directly (disk) or are derived from
  // MB (mem); the metric emit is best-effort and only fires when OTLP is enabled.
  const metrics = buildHostMetrics(
    {
      cpuPct: cpu.cpuPct,
      load1,
      mem: {
        usedBytes: mem.usedMb == null ? null : mem.usedMb * BYTES_PER_MB,
        totalBytes: mem.totalMb == null ? null : mem.totalMb * BYTES_PER_MB,
      },
      disk: {
        usedBytes: disk.usedBytes,
        totalBytes: disk.totalBytes,
        availBytes: disk.availBytes,
        device: disk.device,
        mountpoint: disk.mountpoint,
        type: disk.type,
      },
      worktree: { usedBytes: worktree.usedBytes, count: worktree.count },
    },
    nowMs() * 1_000_000,
  );
  await safe(() => emitMetricsFn(metrics));

  // `await` normalizes both emit seams: the default async defaultEmit (which
  // awaits its own OTLP POST) and the sync makeBuilderEmit (which returns the
  // envelope synchronously and routes the POST into runOnce's drain).
  return await emit(HOST_EVENT_SAMPLED, { entity: "host", label, attrs }, { now });
}

// defaultEmitMetrics — route the semconv metric batch through OTLP using the
// resolved agent config (otlp / both modes only; a no-op on eventlog-only hosts).
// Kept as sampleHost's default so a bare call still ships metrics where enabled;
// tests inject a capturing seam instead. Never throws.
async function defaultEmitMetrics(metrics) {
  try {
    await emitMetrics(metrics, readAgentConfig());
  } catch (err) {
    log.warn({ err: err?.message }, "host: metrics emit failed");
  }
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
