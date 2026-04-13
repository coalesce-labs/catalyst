export interface LinearTicket {
  key: string;
  title: string;
  url: string;
  state: string;
  project: string | null;
  labels: string[];
  fetchedAt: string;
}

export type Runner = (
  args: string[],
) => Promise<{ stdout: string; ok: boolean }>;

export interface LinearFetcher {
  get(key: string): LinearTicket | null;
  refreshAll(keys: string[]): Promise<void>;
  start(keysProvider: () => string[], intervalMs: number): void;
  stop(): void;
}

const DEFAULT_CONCURRENCY = 5;
const LINEAR_BASE_URL = "https://linear.app/issue";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

export function parseTicketJson(raw: string): LinearTicket | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const identifier = asString(parsed.identifier);
  const title = asString(parsed.title);
  if (!identifier || !title) return null;

  const stateName = isRecord(parsed.state)
    ? asString(parsed.state.name, "")
    : "";

  let projectName: string | null = null;
  if (isRecord(parsed.project)) {
    const n = asString(parsed.project.name, "");
    projectName = n || null;
  }

  const labels: string[] = [];
  if (isRecord(parsed.labels) && Array.isArray(parsed.labels.nodes)) {
    for (const node of parsed.labels.nodes) {
      if (isRecord(node)) {
        const name = asString(node.name, "");
        if (name) labels.push(name);
      }
    }
  }

  const url = asString(
    parsed.url,
    `${LINEAR_BASE_URL}/${encodeURIComponent(identifier)}`,
  );

  return {
    key: identifier,
    title,
    url,
    state: stateName,
    project: projectName,
    labels,
    fetchedAt: new Date().toISOString(),
  };
}

async function defaultRunner(
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  try {
    const proc = Bun.spawn(["linearis", ...args], {
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

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const slots = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < slots; i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          const item = items[idx];
          if (item === undefined) return;
          await worker(item as T);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

export function createLinearFetcher(
  opts: { runner?: Runner; concurrency?: number } = {},
): LinearFetcher {
  const runner = opts.runner ?? defaultRunner;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const cache = new Map<string, LinearTicket>();
  let available: boolean | null = null;
  let warned = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function probe(): Promise<boolean> {
    if (available !== null) return available;
    try {
      const res = await runner(["--version"]);
      available = res.ok;
    } catch {
      available = false;
    }
    if (!available && !warned) {
      warned = true;
      console.warn(
        "[linear] linearis CLI unavailable; ticket metadata disabled",
      );
    }
    return available;
  }

  async function fetchOne(key: string): Promise<void> {
    let res: { stdout: string; ok: boolean };
    try {
      res = await runner(["issues", "read", key]);
    } catch (err) {
      console.error(`[linear] runner threw for ${key}:`, err);
      return;
    }
    if (!res.ok || !res.stdout) return;
    const ticket = parseTicketJson(res.stdout);
    if (!ticket) {
      console.warn(`[linear] unrecognized JSON shape for ${key}`);
      return;
    }
    cache.set(ticket.key, ticket);
  }

  async function refreshAll(keys: string[]): Promise<void> {
    const unique = Array.from(new Set(keys.filter((k) => k && k.trim())));
    if (unique.length === 0) return;
    if (!(await probe())) return;
    await runWithConcurrencyLimit(unique, concurrency, fetchOne);
  }

  return {
    get(key) {
      return cache.get(key) ?? null;
    },
    refreshAll,
    start(keysProvider, intervalMs) {
      void refreshAll(keysProvider());
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        void refreshAll(keysProvider());
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
