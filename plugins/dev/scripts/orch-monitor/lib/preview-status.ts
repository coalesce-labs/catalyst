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
  start(prs: PreviewRef[], intervalMs: number): void;
  stop(): void;
}

interface CreatePreviewFetcherOptions {
  runner?: Runner;
  concurrency?: number;
  patterns?: string[];
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
  const cache = new Map<string, PreviewLink[]>();
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

  async function fetchCommentUrls(ref: PreviewRef): Promise<PreviewLink[]> {
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
      return [];
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
  ): Promise<PreviewLink[]> {
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
      return [];
    }

    let entries: DeploymentEntry[];
    try {
      entries = JSON.parse(res.stdout) as DeploymentEntry[];
    } catch (err) {
      console.warn(
        `[preview-status] deployments parse failed for ${ref.repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
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
    const [commentLinks, deployLinks] = await Promise.all([
      fetchCommentUrls(ref),
      fetchDeploymentUrls(ref),
    ]);
    const merged = mergeLinks(commentLinks, deployLinks);
    cache.set(cacheKey(ref.repo, ref.number), merged);
  }

  async function refreshAll(prs: PreviewRef[]): Promise<void> {
    if (prs.length === 0) return;
    const ok = await probeGh();
    if (!ok) return;

    const seen = new Set<string>();
    const queue: PreviewRef[] = [];
    for (const ref of prs) {
      const k = cacheKey(ref.repo, ref.number);
      if (seen.has(k)) continue;
      seen.add(k);
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

  return {
    get(repo: string, number: number): PreviewLink[] {
      return cache.get(cacheKey(repo, number)) ?? [];
    },
    refreshAll,
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
