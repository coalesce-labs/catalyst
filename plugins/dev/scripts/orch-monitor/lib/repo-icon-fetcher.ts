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
//  17. apps/web/public/favicon.ico   (CTL-979: monorepo web app layout, e.g. Adva)
//  18. apps/web/public/favicon.svg
//  19. apps/web/public/favicon.png
//  20. apps/website/public/favicon.ico
//  21. apps/website/public/favicon.svg
//  22. apps/website/public/favicon.png
//
// All matching paths are collected; the best by format (SVG > PNG > ICO) is the default.
// Cache: JSON files in cacheDir (default ~/catalyst/repo-icon-cache/), keyed by
//   owner-repo slug, TTL 7 days (schema v2 — v1 entries re-probe once). A negative
//   result ("no icon found") is also cached (with a 1-day TTL) so we don't hammer
//   the GitHub API on every boot.
//
// Fail-open: any error (no gh binary, API rate-limit, no internet) returns null
// so the UI falls through to the manual-override / lucide fallback.

import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type IconFormat = "svg" | "png" | "ico";

export interface IconCandidate {
  path: string;
  format: IconFormat;
  downloadUrl: string;
  dataUrl: string | null;
}

/** Crispness order: vector first, then raster, then legacy ico container. */
const FORMAT_RANK: Record<IconFormat, number> = { svg: 0, png: 1, ico: 2 };

export function inferIconFormat(path: string): IconFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".ico")) return "ico";
  return "png";
}

/** Best = lowest FORMAT_RANK, tie-broken by ICON_PATH_PRIORITY index. */
export function pickBestCandidate(cands: readonly IconCandidate[]): IconCandidate | null {
  if (cands.length === 0) return null;
  return [...cands].sort((a, b) => {
    const fr = FORMAT_RANK[a.format] - FORMAT_RANK[b.format];
    if (fr !== 0) return fr;
    return ICON_PATH_PRIORITY.indexOf(a.path) - ICON_PATH_PRIORITY.indexOf(b.path);
  })[0];
}

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
  // CTL-979: monorepo web-app layout (e.g. rightsite-cloud/Adva uses apps/web/public/)
  "apps/web/public/favicon.ico",
  "apps/web/public/favicon.svg",
  "apps/web/public/favicon.png",
  "apps/website/public/favicon.ico",
  "apps/website/public/favicon.svg",
  "apps/website/public/favicon.png",
];

export type IconResult =
  | {
      found: true;
      candidates: IconCandidate[];
      selectedPath: string;
      // legacy single-candidate fields, mirror the best candidate (back-compat)
      path: string;
      downloadUrl: string;
      dataUrl: string | null;
    }
  | { found: false };

const CACHE_SCHEMA_VERSION = 2; // v2 carries candidates[] (CTL-997)

interface CacheEntry {
  schemaVersion: number;
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
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return null; // legacy v1 → re-probe
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
    const entry: CacheEntry = { schemaVersion: CACHE_SCHEMA_VERSION, cachedAt: Date.now(), result };
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
 * Probe every path in ICON_PATH_PRIORITY and collect all hits (no early exit).
 * Returns all matching paths with their download URLs.
 * This is the PURE resolver (no cache, no data-URL fetch) — used by fetchRepoIcon.
 */
export function resolveRepoIconCandidates(
  ownerRepo: string,
): { path: string; downloadUrl: string }[] {
  const hits: { path: string; downloadUrl: string }[] = [];
  for (const iconPath of ICON_PATH_PRIORITY) {
    const dl = probeRepoPath(ownerRepo, iconPath);
    if (dl) hits.push({ path: iconPath, downloadUrl: dl });
  }
  return hits;
}

/**
 * Return the first-hit icon for a GitHub repo by ICON_PATH_PRIORITY order (legacy back-compat).
 * Re-implemented atop resolveRepoIconCandidates. For the format-ranked best candidate,
 * call pickBestCandidate(resolveRepoIconCandidates(...)) instead.
 */

/**
 * Fetch the best icon for a GitHub repo, with disk cache.
 * Returns all detected candidates plus the default-best (SVG > PNG > ICO).
 * Legacy top-level path/downloadUrl/dataUrl fields mirror the best candidate.
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
    const hits = resolveRepoIconCandidates(ownerRepo);
    if (hits.length === 0) {
      result = { found: false };
    } else {
      const candidates: IconCandidate[] = await Promise.all(
        hits.map(async (h) => ({
          path: h.path,
          format: inferIconFormat(h.path),
          downloadUrl: h.downloadUrl,
          dataUrl: await fetchAsDataUrl(h.downloadUrl),
        })),
      );
      const best = pickBestCandidate(candidates) ?? candidates[0];
      result = {
        found: true,
        candidates,
        selectedPath: best.path,
        path: best.path,
        downloadUrl: best.downloadUrl,
        dataUrl: best.dataUrl,
      };
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
 * (the repo short-name is the last segment of vcsRepo, lowercased for case-insensitive lookup)
 *
 * CTL-979: keys are lowercased so /api/repo-icon/adva resolves vcsRepo "rightsite-cloud/Adva".
 */
export function buildRepoOwnerMap(
  linearTeams: ReadonlyArray<{ key: string; vcsRepo: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const team of linearTeams) {
    if (!team.vcsRepo || !team.vcsRepo.includes("/")) continue;
    const shortName = team.vcsRepo.split("/").at(-1);
    if (shortName) map[shortName.toLowerCase()] = team.vcsRepo;
  }
  return map;
}
