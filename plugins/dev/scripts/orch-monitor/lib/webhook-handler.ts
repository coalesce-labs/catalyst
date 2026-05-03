import { writeMergedSignalFile } from "./signal-writer";
import { verifyWebhookSignature } from "./webhook-verify";
import { parseWebhookEvent, type WebhookEvent } from "./webhook-events";

export interface PrFetcherForceLike {
  force(ref: { repo: string; number: number }): Promise<void>;
}

export interface WebhookLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface WebhookHandlerDeps {
  /** HMAC signing secret. Empty string disables the handler (returns 503). */
  secret: string;
  /** Used to refresh PR cache on accepted PR-side events. */
  prFetcher: PrFetcherForceLike;
  /**
   * Returns paths of worker signal files that reference (repo, prNumber).
   * The handler writes through `writeMergedSignalFile` on `pull_request.closed`
   * with `merged === true`. Optional — when omitted, no signal files are touched.
   */
  findSignalPaths?: (repo: string, prNumber: number) => string[];
  /** Optional pub/sub for SSE fan-out to UI clients. */
  emit?: (type: string, data: unknown) => void;
  /** Cap for the in-memory delivery-ID dedup set. Default 1000. */
  idempotencyMax?: number;
  logger?: WebhookLogger;
}

export interface WebhookHandler {
  handle(req: Request): Promise<Response>;
  /** True if `deliveryId` was seen in the current process. Used by replay (Phase 3). */
  hasSeenDelivery(deliveryId: string): boolean;
  /** Mark `deliveryId` as seen without dispatching. Used by replay primer. */
  markDelivery(deliveryId: string): void;
  /** Last-webhook-at lookup for fallback-poll freshness filter (Phase 4). */
  getLastWebhookAt(repo: string, prNumber: number): number | null;
}

export function createWebhookHandler(
  deps: WebhookHandlerDeps,
): WebhookHandler {
  const idempotencyMax = deps.idempotencyMax ?? 1000;
  const seenDeliveries: string[] = [];
  const seenDeliveriesSet = new Set<string>();
  const lastWebhookAt = new Map<string, number>();
  const logger = deps.logger ?? {};

  function rememberDelivery(deliveryId: string): void {
    if (seenDeliveriesSet.has(deliveryId)) return;
    seenDeliveriesSet.add(deliveryId);
    seenDeliveries.push(deliveryId);
    while (seenDeliveries.length > idempotencyMax) {
      const oldest = seenDeliveries.shift();
      if (oldest !== undefined) seenDeliveriesSet.delete(oldest);
    }
  }

  function markLastWebhookAt(repo: string, prNumber: number): void {
    if (prNumber <= 0) return;
    lastWebhookAt.set(`${repo}#${prNumber}`, Date.now());
  }

  async function dispatch(event: WebhookEvent): Promise<void> {
    switch (event.kind) {
      case "pull_request": {
        markLastWebhookAt(event.repo, event.number);
        if (event.action === "closed" && event.merged) {
          const paths = deps.findSignalPaths?.(event.repo, event.number) ?? [];
          for (const p of paths) {
            try {
              writeMergedSignalFile(p, event.mergedAt);
            } catch (err) {
              logger.error?.(
                `[webhook] signal-file write failed for ${p}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }
        await deps.prFetcher.force({ repo: event.repo, number: event.number });
        break;
      }
      case "pull_request_review":
      case "pull_request_review_thread": {
        markLastWebhookAt(event.repo, event.number);
        await deps.prFetcher.force({
          repo: event.repo,
          number: event.number,
        });
        break;
      }
      case "check_suite": {
        for (const number of event.prNumbers) {
          markLastWebhookAt(event.repo, number);
          await deps.prFetcher.force({ repo: event.repo, number });
        }
        break;
      }
      case "status": {
        // status events are keyed by SHA, not PR number. The fallback poll
        // (Phase 4) catches stale state within 10 minutes; sha→PR resolution
        // is wired up in Phase 5 via the existing preview-status helpers.
        logger.info?.(
          `[webhook] status received for ${event.repo} sha=${event.sha} state=${event.state}; no-op in Phase 1`,
        );
        break;
      }
      case "push": {
        // BEHIND-detection signal — handled in Phase 4 via cache invalidation.
        // For Phase 1 we just log and let the freshness filter pass through.
        logger.info?.(
          `[webhook] push received for ${event.repo} ${event.ref}; no-op in Phase 1`,
        );
        break;
      }
      case "issue_comment":
      case "pull_request_review_comment":
      case "deployment":
      case "deployment_status":
        logger.info?.(
          `[webhook] ${event.kind} received but not yet handled (Phase 5)`,
        );
        break;
      case "ignored":
        logger.info?.(`[webhook] ignored: ${event.reason}`);
        break;
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (deps.secret.length === 0) {
      return new Response("webhook secret not configured", { status: 503 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const rawBody = new Uint8Array(await req.arrayBuffer());
    const sig = req.headers.get("x-hub-signature-256");
    if (!verifyWebhookSignature(deps.secret, rawBody, sig)) {
      return new Response("signature verification failed", { status: 401 });
    }

    const eventName = req.headers.get("x-github-event") ?? "";
    const deliveryId = req.headers.get("x-github-delivery") ?? "";
    if (eventName.length === 0 || deliveryId.length === 0) {
      return new Response("missing event/delivery headers", { status: 400 });
    }

    if (seenDeliveriesSet.has(deliveryId)) {
      return new Response(JSON.stringify({ ok: true, replay: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    rememberDelivery(deliveryId);

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch (err) {
      logger.warn?.(
        `[webhook] body parse failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return new Response("invalid json body", { status: 400 });
    }

    const event = parseWebhookEvent(eventName, payload);
    try {
      await dispatch(event);
    } catch (err) {
      logger.error?.(
        `[webhook] dispatch failed for ${eventName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    deps.emit?.("webhook-event", { event, deliveryId, eventName });

    return new Response(JSON.stringify({ ok: true, kind: event.kind }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return {
    handle,
    hasSeenDelivery: (id) => seenDeliveriesSet.has(id),
    markDelivery: rememberDelivery,
    getLastWebhookAt: (repo, n) =>
      lastWebhookAt.get(`${repo}#${n}`) ?? null,
  };
}
