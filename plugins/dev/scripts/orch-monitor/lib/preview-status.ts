export interface PreviewLink {
  url: string;
  provider: "cloudflare" | "vercel" | "netlify" | "railway" | "unknown";
  status: "deploying" | "live" | "failed" | "inactive" | "unknown";
  source: "comment" | "deployment" | "description";
}

export interface PreviewRef {
  repo: string;
  number: number;
}

export interface RunnerResult {
  stdout: string;
  ok: boolean;
}

export type Runner = (args: string[]) => Promise<RunnerResult>;

export interface PreviewFetcher {
  get(repo: string, number: number): PreviewLink[];
  refreshAll(prs: PreviewRef[]): Promise<void>;
  /**
   * Bypass refreshAll's filters and force a fetch. Used by webhook handler
   * when an issue_comment / pull_request_review_comment / deployment*
   * event arrives for a known PR.
   */
  force(ref: PreviewRef): Promise<void>;
  start(prs: PreviewRef[], intervalMs: number): void;
  stop(): void;
}

export type PreviewPrState = "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";

interface CreatePreviewFetcherOptions {
  runner?: Runner;
  concurrency?: number;
  patterns?: string[];
  /**
   * Returns the cached PR state for a ref, or null when unknown. When set,
   * refreshAll skips refs whose PR is MERGED/CLOSED — preview state cannot
   * change after the PR closes.
   */
  getPrState?: (ref: PreviewRef) => PreviewPrState | null;
  /** Same shape as prFetcher's lastWebhookAt — skip recent-webhook refs. */
  lastWebhookAt?: (ref: PreviewRef) => number | null;
  webhookFreshnessMs?: number;
}

const DEFAULT_PREVIEW_WEBHOOK_FRESHNESS_MS = 5 * 60_000;
const PREVIEW_BACKOFF_SCHEDULE_MS: readonly number[] = [
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
];

export function previewBackoffMs(unknownStreak: number): number {
  if (unknownStreak <= 0) return 0;
  const idx = Math.min(unknownStreak - 1, PREVIEW_BACKOFF_SCHEDULE_MS.length - 1);
  return PREVIEW_BACKOFF_SCHEDULE_MS[idx];
}

interface PreviewCacheEntry {
  links: PreviewLink[];
  unknownStreak: number;
  nextRetryAt: string | null;
}

export const DEFAULT_PREVIEW_PATTERNS = [
  "*.pages.dev",
  "*.vercel.app",
  "*.netlify.app",
  "*.up.railway.app",
];

const PROVIDER_MAP: Record<string, PreviewLink["provider"]> = {
  "pages.dev": "cloudflare",
  "vercel.app": "vercel",
  "netlify.app": "netlify",
  "up.railway.app": "railway",
};

function patternToRegexSuffix(pattern: string): string {
  return pattern.replace(/^\*\./, "").replace(/\./g, "\\.");
}

function buildUrlRegex(patterns: string[]): RegExp {
  const suffixes = patterns.map(patternToRegexSuffix);
  const alt = suffixes.join("|");
  return new RegExp(
    `https?://[a-zA-Z0-9][a-zA-Z0-9._-]*(?:${alt})(?:/[^\\s)\\]"'<>]*)?`,
    "g",
  );
}

function detectProvider(
  url: string,
  patterns: string[],
): PreviewLink["provider"] {
  for (const pattern of patterns) {
    const suffix = pattern.replace(/^\*\./, "");
    if (PROVIDER_MAP[suffix]) {
      const dotSuffix = "." + suffix;
      try {
        const hostname = new URL(url).hostname;
        if (hostname.endsWith(dotSuffix) || hostname === suffix) {
          return PROVIDER_MAP[suffix];
        }
      } catch {
        continue;
      }
    }
  }
  return "unknown";
}

function extractOrigin(raw: string): string {
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

export function extractPreviewUrls(
  text: string,
  patterns: string[] = DEFAULT_PREVIEW_PATTERNS,
): string[] {
  const regex = buildUrlRegex(patterns);
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const origin = extractOrigin(match[0]);
    if (seen.has(origin)) continue;
    seen.add(origin);
    results.push(origin);
  }
  return results;
}

export function mapDeploymentState(
  state: string,
): PreviewLink["status"] {
  switch (state) {
    case "success":
    case "active":
      return "live";
    case "pending":
    case "in_progress":
    case "queued":
      return "deploying";
    case "error":
    case "failure":
      return "failed";
    case "inactive":
      return "inactive";
    default:
      return "unknown";
  }
}

function cacheKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

async function defaultRunner(args: string[]): Promise<RunnerResult> {
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    return { stdout, ok: exit === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

interface DeploymentEntry {
  environment?: string;
  environment_url?: string;
  state?: string;
}

export function createPreviewFetcher(
  opts: CreatePreviewFetcherOptions = {},
): PreviewFetcher {
  const runner = opts.runner ?? defaultRunner;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const patterns = opts.patterns ?? DEFAULT_PREVIEW_PATTERNS;
  const webhookFreshnessMs =
    opts.webhookFreshnessMs ?? DEFAULT_PREVIEW_WEBHOOK_FRESHNESS_MS;
  const getPrState = opts.getPrState;
  const lastWebhookAt = opts.lastWebhookAt;
  const cache = new Map<string, PreviewCacheEntry>();
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let ghAvailable: boolean | null = null;
  let ghProbeInFlight: Promise<boolean> | null = null;

  async function probeGh(): Promise<boolean> {
    if (ghAvailable !== null) return ghAvailable;
    if (ghProbeInFlight) return ghProbeInFlight;
    ghProbeInFlight = (async () => {
      let ok: boolean;
      try {
        const res = await runner(["gh", "--version"]);
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        console.warn(
          "[preview-status] gh CLI not available — preview status disabled",
        );
      }
      ghAvailable = ok;
      return ok;
    })();
    try {
      return await ghProbeInFlight;
    } finally {
      ghProbeInFlight = null;
    }
  }

  async function fetchCommentUrls(
    ref: PreviewRef,
  ): Promise<PreviewLink[] | null> {
    const res = await runner([
      "gh",
      "api",
      `repos/${ref.repo}/pulls/${ref.number}/comments`,
      "--paginate",
      "--jq",
      ".[].body",
    ]);
    if (!res.ok) {
      console.warn(
        `[preview-status] comments fetch failed for ${ref.repo}#${ref.number}`,
      );
      return null;
    }
    const urls = extractPreviewUrls(res.stdout, patterns);
    return urls.map((url) => ({
      url,
      provider: detectProvider(url, patterns),
      status: "unknown" as const,
      source: "comment" as const,
    }));
  }

  async function fetchDeploymentUrls(
    ref: PreviewRef,
  ): Promise<PreviewLink[] | null> {
    const res = await runner([
      "gh",
      "api",
      `repos/${ref.repo}/deployments`,
      "--jq",
      "[.[] | {environment, environment_url, state}]",
    ]);
    if (!res.ok) {
      console.warn(
        `[preview-status] deployments fetch failed for ${ref.repo}`,
      );
      return null;
    }

    let entries: DeploymentEntry[];
    try {
      entries = JSON.parse(res.stdout) as DeploymentEntry[];
    } catch (err) {
      console.warn(
        `[preview-status] deployments parse failed for ${ref.repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
    if (!Array.isArray(entries)) return [];

    const links: PreviewLink[] = [];
    for (const entry of entries) {
      if (
        typeof entry.environment_url !== "string" ||
        entry.environment_url.length === 0
      )
        continue;
      const origin = extractOrigin(entry.environment_url);
      const matchesPattern = extractPreviewUrls(origin, patterns).length > 0;
      if (!matchesPattern) continue;
      links.push({
        url: origin,
        provider: detectProvider(origin, patterns),
        status: mapDeploymentState(entry.state ?? ""),
        source: "deployment",
      });
    }
    return links;
  }

  function mergeLinks(
    commentLinks: PreviewLink[],
    deployLinks: PreviewLink[],
  ): PreviewLink[] {
    const byUrl = new Map<string, PreviewLink>();
    for (const link of commentLinks) {
      byUrl.set(link.url, link);
    }
    for (const link of deployLinks) {
      const existing = byUrl.get(link.url);
      if (!existing || existing.status === "unknown") {
        byUrl.set(link.url, link);
      }
    }
    return Array.from(byUrl.values());
  }

  async function fetchOne(ref: PreviewRef): Promise<void> {
    const k = cacheKey(ref.repo, ref.number);
    const prev = cache.get(k);
    const [commentLinks, deployLinks] = await Promise.all([
      fetchCommentUrls(ref).catch(() => null),
      fetchDeploymentUrls(ref).catch(() => null),
    ]);
    if (commentLinks === null && deployLinks === null) {
      const unknownStreak = (prev?.unknownStreak ?? 0) + 1;
      const nextRetryAt = new Date(
        Date.now() + previewBackoffMs(unknownStreak),
      ).toISOString();
      cache.set(k, {
        links: prev?.links ?? [],
        unknownStreak,
        nextRetryAt,
      });
      return;
    }
    const merged = mergeLinks(commentLinks ?? [], deployLinks ?? []);
    cache.set(k, {
      links: merged,
      unknownStreak: 0,
      nextRetryAt: null,
    });
  }

  async function refreshAll(prs: PreviewRef[]): Promise<void> {
    if (prs.length === 0) return;
    const ok = await probeGh();
    if (!ok) return;

    const now = Date.now();
    const seen = new Set<string>();
    const queue: PreviewRef[] = [];
    for (const ref of prs) {
      const k = cacheKey(ref.repo, ref.number);
      if (seen.has(k)) continue;
      seen.add(k);
      // Skip terminal PRs — preview state cannot change after merge/close.
      if (getPrState) {
        const state = getPrState(ref);
        if (state === "MERGED" || state === "CLOSED") continue;
      }
      // Respect UNKNOWN backoff.
      const cached = cache.get(k);
      if (
        cached &&
        cached.nextRetryAt !== null &&
        new Date(cached.nextRetryAt).getTime() > now
      ) {
        continue;
      }
      // Skip if a webhook event arrived recently — webhooks are authoritative.
      if (lastWebhookAt) {
        const ts = lastWebhookAt(ref);
        if (ts !== null && now - ts < webhookFreshnessMs) continue;
      }
      queue.push(ref);
    }

    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < queue.length) {
        const idx = cursor++;
        const ref = queue[idx];
        if (!ref) return;
        try {
          await fetchOne(ref);
        } catch (err) {
          console.warn(
            `[preview-status] fetch failed for ${ref.repo}#${ref.number}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    const workers: Promise<void>[] = [];
    const n = Math.min(concurrency, queue.length);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
  }

  async function force(ref: PreviewRef): Promise<void> {
    const ok = await probeGh();
    if (!ok) return;
    try {
      await fetchOne(ref);
    } catch (err) {
      console.warn(
        `[preview-status] force fetch failed for ${ref.repo}#${ref.number}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    get(repo: string, number: number): PreviewLink[] {
      return cache.get(cacheKey(repo, number))?.links ?? [];
    },
    refreshAll,
    force,
    start(prs: PreviewRef[], intervalMs: number): void {
      if (intervalHandle !== null) return;
      void refreshAll(prs);
      intervalHandle = setInterval(() => {
        void refreshAll(prs);
      }, intervalMs);
    },
    stop(): void {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
  };
}
