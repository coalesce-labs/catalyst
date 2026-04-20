export type PrMergeStateStatus =
  | "CLEAN"
  | "BLOCKED"
  | "DIRTY"
  | "BEHIND"
  | "UNSTABLE"
  | "HAS_HOOKS"
  | "UNKNOWN";

export interface PrStatus {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  mergedAt: string | null;
  mergeStateStatus: PrMergeStateStatus;
  isDraft: boolean;
  fetchedAt: string;
}

export interface PrRef {
  repo: string;
  number: number;
}

export interface RunnerResult {
  stdout: string;
  ok: boolean;
}

export type Runner = (args: string[]) => Promise<RunnerResult>;

export interface PrStatusFetcher {
  get(repo: string, number: number): PrStatus | null;
  refreshAll(prs: PrRef[]): Promise<void>;
  start(prs: PrRef[], intervalMs: number): void;
  stop(): void;
}

interface CreatePrStatusFetcherOptions {
  runner?: Runner;
  concurrency?: number;
}

const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function parseRepoFromPrUrl(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const m = PR_URL_RE.exec(url);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
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

interface ParsedPrPayload {
  state?: unknown;
  mergedAt?: unknown;
  mergeStateStatus?: unknown;
  isDraft?: unknown;
}

function normalizeState(raw: unknown): PrStatus["state"] {
  if (raw === "OPEN" || raw === "CLOSED" || raw === "MERGED") return raw;
  return "UNKNOWN";
}

const MERGE_STATE_VALUES: ReadonlySet<PrMergeStateStatus> = new Set([
  "CLEAN",
  "BLOCKED",
  "DIRTY",
  "BEHIND",
  "UNSTABLE",
  "HAS_HOOKS",
  "UNKNOWN",
]);

function normalizeMergeStateStatus(raw: unknown): PrMergeStateStatus {
  if (typeof raw !== "string") return "UNKNOWN";
  const upper = raw.toUpperCase() as PrMergeStateStatus;
  return MERGE_STATE_VALUES.has(upper) ? upper : "UNKNOWN";
}

function normalizeIsDraft(raw: unknown): boolean {
  return raw === true;
}

interface PrByBranchResult {
  number: number;
  state: PrStatus["state"];
  mergedAt: string | null;
  mergeStateStatus: PrMergeStateStatus;
  isDraft: boolean;
  url: string;
}

export async function fetchPrForBranch(
  repo: string,
  branch: string,
  runner: Runner,
): Promise<PrByBranchResult | null> {
  const res = await runner([
    "gh",
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,state,mergedAt,mergeStateStatus,isDraft,url",
    "--limit",
    "1",
  ]);
  if (!res.ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first: unknown = parsed[0];
  if (typeof first !== "object" || first === null) return null;
  const f = first as Record<string, unknown>;
  if (typeof f.number !== "number") return null;
  const mergedAt =
    typeof f.mergedAt === "string" && f.mergedAt.length > 0 ? f.mergedAt : null;
  return {
    number: f.number,
    state: normalizeState(f.state),
    mergedAt,
    mergeStateStatus: normalizeMergeStateStatus(f.mergeStateStatus),
    isDraft: normalizeIsDraft(f.isDraft),
    url: typeof f.url === "string" ? f.url : "",
  };
}

export function createPrStatusFetcher(
  opts: CreatePrStatusFetcherOptions = {},
): PrStatusFetcher {
  const runner = opts.runner ?? defaultRunner;
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const cache = new Map<string, PrStatus>();
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
          "[pr-status] gh CLI not available — PR status refresh disabled",
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

  async function fetchOne(ref: PrRef): Promise<void> {
    const res = await runner([
      "gh",
      "pr",
      "view",
      String(ref.number),
      "--repo",
      ref.repo,
      "--json",
      "state,mergedAt,mergeStateStatus,isDraft",
    ]);
    const fetchedAt = new Date().toISOString();
    if (!res.ok) {
      cache.set(cacheKey(ref.repo, ref.number), {
        number: ref.number,
        state: "UNKNOWN",
        mergedAt: null,
        mergeStateStatus: "UNKNOWN",
        isDraft: false,
        fetchedAt,
      });
      return;
    }
    let parsed: ParsedPrPayload;
    try {
      parsed = JSON.parse(res.stdout) as ParsedPrPayload;
    } catch (err) {
      console.warn(
        `[pr-status] parse failed for ${ref.repo}#${ref.number}:`,
        err instanceof Error ? err.message : String(err),
      );
      cache.set(cacheKey(ref.repo, ref.number), {
        number: ref.number,
        state: "UNKNOWN",
        mergedAt: null,
        mergeStateStatus: "UNKNOWN",
        isDraft: false,
        fetchedAt,
      });
      return;
    }
    const state = normalizeState(parsed.state);
    const mergedAt =
      typeof parsed.mergedAt === "string" && parsed.mergedAt.length > 0
        ? parsed.mergedAt
        : null;
    cache.set(cacheKey(ref.repo, ref.number), {
      number: ref.number,
      state,
      mergedAt,
      mergeStateStatus: normalizeMergeStateStatus(parsed.mergeStateStatus),
      isDraft: normalizeIsDraft(parsed.isDraft),
      fetchedAt,
    });
  }

  async function refreshAll(prs: PrRef[]): Promise<void> {
    if (prs.length === 0) return;
    const ok = await probeGh();
    if (!ok) return;
    // Dedupe
    const seen = new Set<string>();
    const queue: PrRef[] = [];
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
            `[pr-status] fetch failed for ${ref.repo}#${ref.number}:`,
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
    get(repo: string, number: number): PrStatus | null {
      return cache.get(cacheKey(repo, number)) ?? null;
    },
    refreshAll,
    start(prs: PrRef[], intervalMs: number): void {
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
