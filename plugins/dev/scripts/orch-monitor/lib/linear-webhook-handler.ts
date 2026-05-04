import { verifyLinearSignature } from "./linear-webhook-verify";
import {
  parseLinearWebhookEvent,
  type LinearWebhookEvent,
} from "./linear-webhook-events";
import {
  type EventLogWriter,
  type AppendableEvent,
} from "./event-log";

export const LINEAR_WEBHOOK_SOURCE = "linear.webhook";

export interface LinearWebhookLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface LinearWebhookHandlerDeps {
  /** HMAC signing secret. Empty string disables the handler (returns 503). */
  secret: string;
  /** Optional pub/sub for SSE fan-out to UI clients. */
  emit?: (type: string, data: unknown) => void;
  /** Event-log fan-out — every accepted event is appended here. */
  eventLog?: EventLogWriter;
  /**
   * Hook fired AFTER an event is parsed, logged, and emitted. Lets the server
   * react to ticket-scoped events without the handler needing to know about
   * the consumers (e.g. invalidate the LinearFetcher cache on
   * `linear.issue.state_changed`). CTL-211. Failures are logged and swallowed
   * so a slow consumer never blocks the webhook response.
   */
  onAccept?: (event: LinearWebhookEvent) => void | Promise<void>;
  /** Cap for the in-memory delivery-ID dedup set. Default 1000. */
  idempotencyMax?: number;
  logger?: LinearWebhookLogger;
}

export interface LinearWebhookHandler {
  handle(req: Request): Promise<Response>;
  hasSeenDelivery(deliveryId: string): boolean;
  markDelivery(deliveryId: string): void;
}

/**
 * Map a parsed LinearWebhookEvent to a unified-event-log envelope.
 *
 * Topic namespace: `linear.<noun>.<verb>` — e.g. `linear.issue.state_changed`,
 * `linear.comment.created`. Returns null for `kind: "ignored"`.
 */
export function buildLinearEventLogEnvelope(
  event: LinearWebhookEvent,
  deliveryId: string,
): AppendableEvent | null {
  const id = `evt_linear_${deliveryId}`;
  switch (event.kind) {
    case "issue":
      return {
        id,
        source: LINEAR_WEBHOOK_SOURCE,
        event: event.topic,
        scope: {
          ticket: event.ticket ?? undefined,
        },
        detail: {
          action: event.action,
          ticket: event.ticket,
          teamKey: event.teamKey,
          updatedFromKeys: event.updatedFromKeys,
        },
      };
    case "comment":
      return {
        id,
        source: LINEAR_WEBHOOK_SOURCE,
        event: `linear.comment.${event.action}d`,
        scope: {
          ticket: event.ticket ?? undefined,
        },
        detail: {
          action: event.action,
          commentId: event.commentId,
          issueId: event.issueId,
          ticket: event.ticket,
        },
      };
    case "cycle":
      return {
        id,
        source: LINEAR_WEBHOOK_SOURCE,
        event: `linear.cycle.${event.action}d`,
        scope: {},
        detail: {
          action: event.action,
          cycleId: event.cycleId,
          teamKey: event.teamKey,
        },
      };
    case "reaction":
      return {
        id,
        source: LINEAR_WEBHOOK_SOURCE,
        event: `linear.reaction.${event.action}d`,
        scope: {},
        detail: {
          action: event.action,
          reactionId: event.reactionId,
        },
      };
    case "issue_label":
      return {
        id,
        source: LINEAR_WEBHOOK_SOURCE,
        event: `linear.issue_label.${event.action}d`,
        scope: {},
        detail: {
          action: event.action,
          labelId: event.labelId,
        },
      };
    case "ignored":
      return null;
  }
}

export function createLinearWebhookHandler(
  deps: LinearWebhookHandlerDeps,
): LinearWebhookHandler {
  const idempotencyMax = deps.idempotencyMax ?? 1000;
  const seenDeliveries: string[] = [];
  const seenDeliveriesSet = new Set<string>();
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

  async function handle(req: Request): Promise<Response> {
    if (deps.secret.length === 0) {
      return new Response("linear webhook secret not configured", {
        status: 503,
      });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const rawBody = new Uint8Array(await req.arrayBuffer());
    const sig = req.headers.get("linear-signature");
    if (!verifyLinearSignature(deps.secret, rawBody, sig)) {
      return new Response("signature verification failed", { status: 401 });
    }

    const eventName = req.headers.get("linear-event") ?? "";
    const deliveryId = req.headers.get("linear-delivery") ?? "";
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
        `[linear-webhook] body parse failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return new Response("invalid json body", { status: 400 });
    }

    const event = parseLinearWebhookEvent(eventName, payload);

    if (deps.eventLog && event.kind !== "ignored") {
      const envelope = buildLinearEventLogEnvelope(event, deliveryId);
      if (envelope !== null) {
        try {
          await deps.eventLog.append(envelope);
        } catch (err) {
          logger.warn?.(
            `[linear-webhook] event-log append failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    deps.emit?.("linear-webhook-event", { event, deliveryId, eventName });

    if (deps.onAccept && event.kind !== "ignored") {
      try {
        await deps.onAccept(event);
      } catch (err) {
        logger.warn?.(
          `[linear-webhook] onAccept hook failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (event.kind === "ignored") {
      logger.info?.(`[linear-webhook] ignored: ${event.reason}`);
    }

    return new Response(JSON.stringify({ ok: true, kind: event.kind }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return {
    handle,
    hasSeenDelivery: (id) => seenDeliveriesSet.has(id),
    markDelivery: rememberDelivery,
  };
}
