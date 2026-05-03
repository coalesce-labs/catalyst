/**
 * On startup, replays GitHub webhook deliveries from the last N hours so the
 * orch-monitor recovers from missed events while it was down.
 *
 * Uses GitHub's hook deliveries API:
 *   - `GET /repos/{repo}/hooks/{hookId}/deliveries` — list summaries
 *   - `GET /repos/{repo}/hooks/{hookId}/deliveries/{deliveryId}` — full payload
 *
 * Each delivery is signed synthetically (we own the secret) and dispatched
 * through the same handler used for live deliveries, so the in-handler
 * idempotency cache prevents double-processing of events that arrived live.
 */

import { createHmac } from "node:crypto";

export interface ReplayRunnerResult {
  stdout: string;
  ok: boolean;
}

export type ReplayRunner = (args: string[]) => Promise<ReplayRunnerResult>;

export interface ReplayLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

/** Just the slice of the handler the replay calls. */
export interface ReplayHandler {
  handle(req: Request): Promise<Response>;
  hasSeenDelivery(deliveryId: string): boolean;
}

export interface WebhookReplay {
  /**
   * Replays deliveries for each (repo, hookId) since the given timestamp.
   * Returns the count of deliveries dispatched (excluding ones already seen).
   */
  replaySince(
    repos: Array<{ repo: string; hookId: number }>,
    since: Date,
  ): Promise<number>;
}

export interface CreateWebhookReplayOpts {
  runner: ReplayRunner;
  handler: ReplayHandler;
  /** HMAC secret used to sign synthetic Request payloads on replay. */
  secret: string;
  /** Override the local target URL passed to the synthesized Request (cosmetic). */
  target?: string;
  logger?: ReplayLogger;
}

interface DeliverySummary {
  id: number;
  guid: string;
  delivered_at: string;
  event: string;
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseDeliverySummaries(stdout: string): DeliverySummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DeliverySummary[] = [];
  for (const entry of parsed) {
    if (!isStringRecord(entry)) continue;
    const id = entry.id;
    const guid = entry.guid;
    const deliveredAt = entry.delivered_at;
    const event = entry.event;
    if (
      typeof id === "number" &&
      typeof guid === "string" &&
      typeof deliveredAt === "string" &&
      typeof event === "string"
    ) {
      out.push({ id, guid, delivered_at: deliveredAt, event });
    }
  }
  return out;
}

interface DeliveryDetail {
  guid: string;
  event: string;
  payload: unknown;
}

function parseDeliveryDetail(stdout: string): DeliveryDetail | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isStringRecord(parsed)) return null;
  const guid = parsed.guid;
  const event = parsed.event;
  const reqRaw = parsed.request;
  if (typeof guid !== "string" || typeof event !== "string") return null;
  let payload: unknown = null;
  if (isStringRecord(reqRaw)) {
    const payloadRaw = reqRaw.payload;
    if (typeof payloadRaw === "string") {
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        payload = null;
      }
    } else if (payloadRaw !== undefined) {
      payload = payloadRaw;
    }
  }
  return { guid, event, payload };
}

export function createWebhookReplay(
  opts: CreateWebhookReplayOpts,
): WebhookReplay {
  const log = opts.logger ?? {};
  const target = opts.target ?? "http://localhost/api/webhook";

  function signBody(body: string): string {
    return (
      "sha256=" + createHmac("sha256", opts.secret).update(body).digest("hex")
    );
  }

  async function listDeliveries(
    repo: string,
    hookId: number,
  ): Promise<DeliverySummary[]> {
    const res = await opts.runner([
      "gh",
      "api",
      `repos/${repo}/hooks/${hookId}/deliveries`,
      "--paginate",
    ]);
    if (!res.ok) {
      log.warn?.(
        `[webhook-replay] failed to list deliveries for ${repo}/${hookId}`,
      );
      return [];
    }
    return parseDeliverySummaries(res.stdout);
  }

  async function fetchDetail(
    repo: string,
    hookId: number,
    deliveryId: number,
  ): Promise<DeliveryDetail | null> {
    const res = await opts.runner([
      "gh",
      "api",
      `repos/${repo}/hooks/${hookId}/deliveries/${deliveryId}`,
    ]);
    if (!res.ok) {
      log.warn?.(
        `[webhook-replay] failed to fetch delivery ${deliveryId} for ${repo}`,
      );
      return null;
    }
    return parseDeliveryDetail(res.stdout);
  }

  async function replayOne(
    repo: string,
    hookId: number,
    summary: DeliverySummary,
  ): Promise<boolean> {
    if (opts.handler.hasSeenDelivery(summary.guid)) return false;
    const detail = await fetchDetail(repo, hookId, summary.id);
    if (detail === null || detail.payload === null) return false;
    const body = JSON.stringify(detail.payload);
    const req = new Request(target, {
      method: "POST",
      headers: {
        "x-github-event": detail.event,
        "x-github-delivery": detail.guid,
        "x-hub-signature-256": signBody(body),
        "content-type": "application/json",
      },
      body,
    });
    const res = await opts.handler.handle(req);
    return res.status === 200;
  }

  async function replaySince(
    repos: Array<{ repo: string; hookId: number }>,
    since: Date,
  ): Promise<number> {
    const sinceMs = since.getTime();
    let dispatched = 0;
    for (const { repo, hookId } of repos) {
      try {
        const summaries = await listDeliveries(repo, hookId);
        const recent = summaries.filter((s) => {
          const t = Date.parse(s.delivered_at);
          return Number.isFinite(t) && t >= sinceMs;
        });
        log.info?.(
          `[webhook-replay] ${repo}: ${recent.length}/${summaries.length} deliveries to replay`,
        );
        for (const summary of recent) {
          try {
            const ok = await replayOne(repo, hookId, summary);
            if (ok) dispatched++;
          } catch (err) {
            log.error?.(
              `[webhook-replay] dispatch failed for ${summary.guid}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } catch (err) {
        log.error?.(
          `[webhook-replay] error replaying ${repo}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return dispatched;
  }

  return { replaySince };
}
