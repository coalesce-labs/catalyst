import { mkdtempSync, cpSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

let cached: string | undefined;

/**
 * Build the orch-monitor UI into a temp dir (once per test process) and
 * return the path. Uses MONITOR_UI_DIST_DIR so nothing is written under
 * the repo's public/. Also copies non-vite statics (favicon, mockups,
 * vendor, history.html) to mirror what catalyst-monitor.sh does. (CTL-1120)
 */
export function ensureTestDist(): string {
  if (cached) return cached;
  const dist = mkdtempSync(join(tmpdir(), "orch-monitor-testdist-"));
  const monitorRoot = resolve(import.meta.dir, "..", "..");
  const proc = Bun.spawnSync(["bun", "run", "build:ui"], {
    cwd: monitorRoot,
    env: { ...process.env, MONITOR_UI_DIST_DIR: dist },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`build:ui failed: ${proc.stderr.toString()}`);
  }
  // Mirror catalyst-monitor.sh static copy: favicon/mockups/vendor/history.html.
  const publicDir = join(monitorRoot, "public");
  for (const file of ["history.html", "favicon.ico", "favicon.svg"]) {
    const src = join(publicDir, file);
    if (existsSync(src)) cpSync(src, join(dist, file));
  }
  for (const dir of ["vendor", "mockups"]) {
    const src = join(publicDir, dir);
    if (existsSync(src)) cpSync(src, join(dist, dir), { recursive: true });
  }
  cached = dist;
  return dist;
}
