/**
 * Manages GitHub repo-level webhook subscriptions for the orch-monitor.
 *
 * On first observation of a (owner/repo), checks for an existing matching hook
 * (config.url === smeeChannel) and creates one if absent. All gh failures are
 * logged but non-fatal — the daemon stays functional via the polling fallback.
 */

export interface SubscriberRunnerResult {
  stdout: string;
  ok: boolean;
}

export type SubscriberRunner = (
  args: string[],
) => Promise<SubscriberRunnerResult>;

export interface SubscriberLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface WebhookSubscriber {
  /**
   * Idempotent. Safe to fire-and-forget. Concurrent calls for the same repo
   * dedupe to a single in-flight subscription attempt.
   */
  ensureSubscribed(repo: string): Promise<void>;
  /** Returns repos with their hook IDs. Used by replay (Phase 3). */
  listSubscribed(): Array<{ repo: string; hookId: number }>;
}

export interface CreateWebhookSubscriberOpts {
  /** smee.io channel URL — used as the hook's `config.url`. */
  smeeChannel: string;
  /** HMAC secret — used as the hook's `config.secret`. */
  secret: string;
  /** Subscribed event types (e.g. ["pull_request", "check_suite", ...]). */
  events: string[];
  /** Subprocess runner for `gh` invocations (test override point). */
  runner: SubscriberRunner;
  logger?: SubscriberLogger;
}

interface CachedHook {
  hookId: number;
}

export function createWebhookSubscriber(
  opts: CreateWebhookSubscriberOpts,
): WebhookSubscriber {
  const log = opts.logger ?? {};
  const cache = new Map<string, CachedHook>();
  const inflight = new Map<string, Promise<void>>();

  function normalizeChannel(url: string): string {
    return url.toLowerCase();
  }

  async function listExistingHook(
    repo: string,
  ): Promise<{ hookId: number; events: string[] } | null> {
    const res = await opts.runner([
      "gh",
      "api",
      `repos/${repo}/hooks`,
    ]);
    if (!res.ok) {
      log.warn?.(
        `[webhook-subscriber] failed to list hooks for ${repo}; skipping`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      log.warn?.(
        `[webhook-subscriber] hooks list parse failed for ${repo}`,
      );
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const want = normalizeChannel(opts.smeeChannel);
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const hook = entry as Record<string, unknown>;
      const config = hook.config;
      if (typeof config !== "object" || config === null) continue;
      const url = (config as Record<string, unknown>).url;
      if (typeof url !== "string") continue;
      if (normalizeChannel(url) !== want) continue;
      const id = hook.id;
      if (typeof id !== "number") continue;
      const eventsRaw = hook.events;
      const events: string[] = Array.isArray(eventsRaw)
        ? eventsRaw.filter((e): e is string => typeof e === "string")
        : [];
      return { hookId: id, events };
    }
    return null;
  }

  async function updateHookEvents(
    repo: string,
    hookId: number,
  ): Promise<boolean> {
    const args: string[] = [
      "gh",
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/hooks/${hookId}`,
    ];
    for (const evt of opts.events) {
      args.push("-f", `events[]=${evt}`);
    }
    const res = await opts.runner(args);
    if (!res.ok) {
      log.warn?.(
        `[webhook-subscriber] failed to upgrade events for ${repo} hook ${hookId}`,
      );
      return false;
    }
    log.info?.(
      `[webhook-subscriber] upgraded events for ${repo} hook ${hookId} → ${opts.events.join(",")}`,
    );
    return true;
  }

  function eventsMatch(have: string[], want: readonly string[]): boolean {
    if (have.length !== want.length) return false;
    const haveSet = new Set(have);
    for (const e of want) if (!haveSet.has(e)) return false;
    return true;
  }

  async function createHook(repo: string): Promise<number | null> {
    const args: string[] = [
      "gh",
      "api",
      "-X",
      "POST",
      `repos/${repo}/hooks`,
      "-f",
      "name=web",
      "-F",
      "active=true",
      "-f",
      `config[url]=${opts.smeeChannel}`,
      "-f",
      `config[content_type]=json`,
      "-f",
      `config[secret]=${opts.secret}`,
    ];
    for (const evt of opts.events) {
      args.push("-f", `events[]=${evt}`);
    }
    const res = await opts.runner(args);
    if (!res.ok) {
      log.warn?.(
        `[webhook-subscriber] failed to create hook for ${repo}; falling back to polling`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      log.warn?.(`[webhook-subscriber] create response parse failed for ${repo}`);
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const id = (parsed as Record<string, unknown>).id;
    return typeof id === "number" ? id : null;
  }

  async function doEnsure(repo: string): Promise<void> {
    if (cache.has(repo)) return;
    try {
      const existing = await listExistingHook(repo);
      if (existing !== null) {
        // CTL-226: self-heal stale event-list subscriptions. When the daemon
        // adds a new event type to DEFAULT_WEBHOOK_EVENTS, existing hooks
        // (created against the old list) won't receive the new types until
        // patched. PATCH failure is non-fatal.
        if (!eventsMatch(existing.events, opts.events)) {
          await updateHookEvents(repo, existing.hookId);
        }
        cache.set(repo, { hookId: existing.hookId });
        log.info?.(
          `[webhook-subscriber] reusing existing hook ${existing.hookId} for ${repo}`,
        );
        return;
      }
      const created = await createHook(repo);
      if (created !== null) {
        cache.set(repo, { hookId: created });
        log.info?.(
          `[webhook-subscriber] subscribed to ${repo} (hook ${created})`,
        );
      }
    } catch (err) {
      log.error?.(
        `[webhook-subscriber] unexpected error for ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async function ensureSubscribed(repo: string): Promise<void> {
    if (cache.has(repo)) return;
    const existing = inflight.get(repo);
    if (existing) return existing;
    const p = doEnsure(repo).finally(() => {
      inflight.delete(repo);
    });
    inflight.set(repo, p);
    return p;
  }

  function listSubscribed(): Array<{ repo: string; hookId: number }> {
    return Array.from(cache.entries()).map(([repo, h]) => ({
      repo,
      hookId: h.hookId,
    }));
  }

  return { ensureSubscribed, listSubscribed };
}

export const DEFAULT_WEBHOOK_EVENTS: readonly string[] = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_thread",
  "pull_request_review_comment",
  "check_suite",
  "workflow_run",
  "status",
  "push",
  "issue_comment",
  "deployment",
  "deployment_status",
  "release",
];
