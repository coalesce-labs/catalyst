// host-memory.mjs — cross-platform "actually available" host memory.
//
// os.freemem() only counts the kernel's free-page list. On macOS that
// excludes inactive/speculative/purgeable pages, which the kernel reclaims
// on demand with no disk I/O — under normal load those categories routinely
// hold 15-20+ GB on a 48GB box. Reading freemem() alone against a fixed MB
// floor chronically misreads a healthy host as near-OOM (confirmed 2026-08-08
// on a fleet host: freemem() read 3.7GB "free" against an 8192MB floor while
// vm_stat's reclaimable total was ~20GB). availableMemMb() adds those
// categories back in on darwin, matching what macOS's own memory_pressure
// tool and Activity Monitor's "Memory Used" figure treat as available; other
// platforms fall back to freemem() unchanged.

import { execFileSync } from "node:child_process";
import { freemem, platform } from "node:os";

const PAGE_SIZE_RE = /page size of (\d+) bytes/;
const VM_STAT_LINE_RE = /^Pages\s+([a-z ]+?):\s+(\d+)\.?\s*$/i;

/**
 * parseVmStatAvailableMb — pure parse of raw `vm_stat` stdout into the
 * reclaimable-without-disk-I/O total: free + inactive + speculative +
 * purgeable pages. Active and wired pages are NOT included — those are
 * genuinely in use. Platform-independent (no subprocess, no os.platform()
 * check) so it's exercisable in CI regardless of runner OS.
 *
 * @param {string} text raw `vm_stat` stdout
 * @returns {number} MB
 */
export function parseVmStatAvailableMb(text) {
  const pageSizeMatch = text.match(PAGE_SIZE_RE);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
  const pages = {};
  for (const line of text.split("\n")) {
    const m = line.match(VM_STAT_LINE_RE);
    if (m) pages[m[1].trim().toLowerCase()] = Number(m[2]);
  }
  const reclaimablePages =
    (pages["free"] ?? 0) +
    (pages["inactive"] ?? 0) +
    (pages["speculative"] ?? 0) +
    (pages["purgeable"] ?? 0);
  return Math.round((reclaimablePages * pageSize) / 1024 / 1024);
}

// defaultVmStat — real `vm_stat` invocation, injectable for tests.
function defaultVmStat() {
  return execFileSync("vm_stat", { encoding: "utf8" });
}

/**
 * availableMemMb — best-effort "actually available" host memory in MB.
 * Returns null on any failure so callers degrade to headroom-unknown rather
 * than crash or silently misreport.
 *
 * @param {object} [opts]
 * @param {Function} [opts.vmStat]           `vm_stat` output injector, darwin only
 * @param {Function} [opts.platformOverride] () => string, injectable for tests (default: real os.platform())
 */
export function availableMemMb({ vmStat = defaultVmStat, platformOverride = platform } = {}) {
  try {
    if (platformOverride() === "darwin") return parseVmStatAvailableMb(vmStat());
    return Math.round(freemem() / 1024 / 1024);
  } catch {
    return null;
  }
}
