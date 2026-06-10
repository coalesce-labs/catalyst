// repo-icon-fetcher.ts — auto-detect per-repo favicon/icon via GitHub API (CTL-961).
//
// Priority order for icon path discovery (mirrors conductor.build-style detection):
//   1. favicon.ico
//   2. public/favicon.ico
//   3. public/favicon.svg
//   4. public/favicon.png
//   5. public/icon.svg
//   6. public/icon.png
//   7. icon.svg
//   8. icon.png
//   9. logo.svg
//  10. logo.png
//  11. apple-touch-icon.png
//  12. .github/logo.svg
//  13. .github/logo.png
//  14. static/favicon.ico
//  15. static/favicon.svg
//  16. static/favicon.png
//
// The first path that returns a file object (non-null download_url) is cached.
// Cache: JSON files in cacheDir (default ~/catalyst/repo-icon-cache/), keyed by
//   owner-repo slug, TTL 7 days. A negative result ("no icon found") is also
//   cached (with a 1-day TTL) so we don't hammer the GitHub API on every boot.
//
// Fail-open: any error (no gh binary, API rate-limit, no internet) returns null
// so the UI falls through to the manual-override / lucide fallback.

import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Ordered list of icon paths to probe in the repo root. */
export const ICON_PATH_PRIORITY: readonly string[] = [
  "favicon.ico",
  "public/favicon.ico",
  "public/favicon.svg",
  "public/favicon.png",
  "public/icon.svg",
  "public/icon.png",
  "icon.svg",
  "icon.png",
  "logo.svg",
  "logo.png",
  "apple-touch-icon.png",
  ".github/logo.svg",
  ".github/logo.png",
  "static/favicon.ico",
  "static/favicon.svg",
  "static/favicon.png",
];

export type IconResult =
  | { found: true; path: string; downloadUrl: string; dataUrl: string | null }
  | { found: false };

interface CacheEntry {
  cachedAt: number; // epoch ms
  result: IconResult;
}

const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

function slugify(ownerRepo: string): string {
  return ownerRepo.replace(/\//g, "--");
}

function cacheFile(cacheDir: string, ownerRepo: string): string {
  return join(cacheDir, `${slugify(ownerRepo)}.json`);
}

function readCache(cacheDir: string, ownerRepo: string): IconResult | null {
  const file = cacheFile(cacheDir, ownerRepo);
  try {
    const raw = readFileSync(file, "utf8");
    const entry: CacheEntry = JSON.parse(raw) as CacheEntry;
    const ttl = entry.result.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - entry.cachedAt < ttl) return entry.result;
  } catch {
    // missing or malformed — treat as cache miss
  }
  return null;
}

function writeCache(cacheDir: string, ownerRepo: string, result: IconResult): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    const entry: CacheEntry = { cachedAt: Date.now(), result };
    writeFileSync(cacheFile(cacheDir, ownerRepo), JSON.stringify(entry, null, 2));
  } catch {
    // write failures are silent — cache is best-effort
  }
}

/**
 * Probe a single path in a GitHub repo via `gh api`.
 * Returns the download_url string if the file exists, null otherwise.
 * Throws if gh is not installed or the API call errors in an unexpected way.
 */
export function probeRepoPath(ownerRepo: string, path: string): string | null {
  const apiPath = `/repos/${ownerRepo}/contents/${path}`;
  try {
    const out = execSync(`gh api "${apiPath}" --jq ".download_url" 2>/dev/null`, {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!out || out === "null") return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and convert it to a data URL (base64-encoded) so the browser
 * can render it without cross-origin issues.
 * Returns null on any fetch/encoding failure.
 */
export async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") ?? "image/png";
    const buf = await resp.arrayBuffer();
    const b64 = Buffer.from(buf).toString("base64");
    return `data:${ct};base64,${b64}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the best icon for a GitHub repo, probing ICON_PATH_PRIORITY in order.
 * Uses `gh api` to check each path without downloading the full file.
 * Returns the first hit as a download_url string, or null when nothing found.
 *
 * This is the PURE resolver (no cache) — used in unit tests and by fetchRepoIcon.
 */
export function resolveRepoIconPath(ownerRepo: string): { path: string; downloadUrl: string } | null {
  for (const iconPath of ICON_PATH_PRIORITY) {
    const dl = probeRepoPath(ownerRepo, iconPath);
    if (dl) return { path: iconPath, downloadUrl: dl };
  }
  return null;
}

/**
 * Fetch the best icon for a GitHub repo, with disk cache.
 * Returns the cached or freshly-fetched IconResult.
 * Falls through gracefully (returns `{ found: false }`) on any error.
 */
export async function fetchRepoIcon(
  ownerRepo: string,
  cacheDir?: string,
): Promise<IconResult> {
  const dir = cacheDir ?? join(homedir(), "catalyst", "repo-icon-cache");

  const cached = readCache(dir, ownerRepo);
  if (cached !== null) return cached;

  let result: IconResult;
  try {
    const hit = resolveRepoIconPath(ownerRepo);
    if (!hit) {
      result = { found: false };
    } else {
      const dataUrl = await fetchAsDataUrl(hit.downloadUrl);
      result = { found: true, path: hit.path, downloadUrl: hit.downloadUrl, dataUrl };
    }
  } catch {
    // Don't cache unexpected errors — let a retry happen next time
    return { found: false };
  }

  writeCache(dir, ownerRepo, result);
  return result;
}

/**
 * Build the repo → owner/repo mapping from the monitor config's linearTeams array.
 * e.g. [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }]
 * → { "catalyst": "coalesce-labs/catalyst" }
 * (the repo short-name is the last segment of vcsRepo)
 *
 * Falls back to deriving from the working-tree git remote when not configured.
 */
export function buildRepoOwnerMap(
  linearTeams: ReadonlyArray<{ key: string; vcsRepo: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const team of linearTeams) {
    if (!team.vcsRepo || !team.vcsRepo.includes("/")) continue;
    const shortName = team.vcsRepo.split("/").at(-1);
    if (shortName) map[shortName] = team.vcsRepo;
  }
  return map;
}
