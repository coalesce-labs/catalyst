import { verifyLinearSignature } from "./linear-webhook-verify";
import { parseLinearWebhookEvent, type LinearWebhookEvent } from "./linear-webhook-events";
import { type EventLogWriter } from "./event-log";
import { buildCanonicalEvent, type CanonicalEvent, type Attributes } from "./canonical-event";

const LINEAR_SERVICE_NAME = "catalyst.linear" as const;

export interface LinearWebhookLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface LinearWebhookHandlerDeps {
  /**
   * HMAC signing secrets. Array of {key, secret} pairs for multi-team support.
   * Key is "workspace" or a team UUID. Handler tries each secret until one validates.
   * Empty array disables the handler (returns 503).
   */
  linearSecrets: Array<{ key: string; secret: string }>;
  /**
   * Optional team→repo map (CTL-362). When an issue / comment / cycle webhook
   * carries a team key that appears here, the canonical envelope gets
   * `attributes["vcs.repository.name"]` set so the HUD's REPO column populates.
   * Sourced from `catalyst.monitor.linear.teams[]` in project config.
   */
  linearTeams?: Array<{ key: string; vcsRepo: string }>;
  /** Optional pub/sub for SSE fan-out to UI clients. */
  emit?: (type: string, data: unknown) => void;
  /** Event-log fan-out — every accepted event is appended here as a canonical envelope. */
  eventLog?: EventLogWriter;
  /**
   * Hook fired AFTER an event is parsed, logged, and emitted. Lets the server
   * react to ticket-scoped events without the handler needing to know about
   * the consumers. Failures are logged and swallowed so a slow consumer never
   * blocks the webhook response.
   */
  onAccept?: (event: LinearWebhookEvent) => void | Promise<void>;
  /**
   * Linear bot user UUIDs for loop prevention. Issue events where the actor
   * matches any ID in the set are suppressed before reaching the event log.
   * Accepts either a ReadonlySet<string> (new) or a plain string (legacy, for
   * callers that haven't migrated yet). Absent / empty = no suppression.
   */
  botUserIds?: ReadonlySet<string> | string;
  /** Cap for the in-memory delivery-ID dedup set. Default 1000. */
  idempotencyMax?: number;
  logger?: LinearWebhookLogger;
}

export interface LinearWebhookHandler {
  handle(req: Request): Promise<Response>;
  hasSeenDelivery(deliveryId: string): boolean;
  markDelivery(deliveryId: string): void;
}

interface LinearCanonicalArgs {
  ts: string;
  eventName: string;
  entity: string;
  action: string;
  label?: string | undefined;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  attrs: Omit<Attributes, "event.name">;
  message: string;
  payload: unknown;
}

function canonical(args: LinearCanonicalArgs): CanonicalEvent {
  const attributes: Attributes = {
    ...args.attrs,
    "event.name": args.eventName,
    "event.entity": args.entity,
    "event.action": args.action,
    "event.channel": "webhook",
  };
  if (args.label !== undefined) {
    attributes["event.label"] = args.label;
  }
  return buildCanonicalEvent({
    ts: args.ts,
    severityText: args.severity,
    traceId: null,
    spanId: null,
    resource: { "service.name": LINEAR_SERVICE_NAME },
    attributes,
    body: { message: args.message, payload: args.payload },
  });
}

// CTL-362: derive a Linear team short key from a ticket identifier like
// "CTL-210" → "CTL". Returns null when the ticket does not match the standard
// Linear identifier shape (uppercase prefix, dash, digits).
const TICKET_PREFIX_RE = /^([A-Z][A-Z0-9]+)-\d+$/;
function deriveTeamKey(ticket: string | null): string | null {
  if (ticket === null) return null;
  const m = TICKET_PREFIX_RE.exec(ticket);
  return m !== null && m[1] !== undefined ? m[1] : null;
}

/**
 * Map a parsed LinearWebhookEvent to a canonical event envelope. Returns null
 * for `kind: "ignored"`.
 *
 * `event.name` follows `linear.<entity>.<action>` lowercase, dot-separated.
 *
 * CTL-362: when `teamsMap` is provided, issue/comment/cycle events whose team
 * key matches an entry get `attributes["vcs.repository.name"]` populated so the
 * HUD's REPO column resolves. Comment events derive the team key from the
 * ticket prefix (e.g. CTL-210 → "CTL") since the webhook payload does not
 * carry it directly. Reaction and issue_label events have no team context and
 * remain unenriched.
 */
export function buildLinearEventLogEnvelope(
  event: LinearWebhookEvent,
  ts: string = new Date().toISOString(),
  teamsMap: ReadonlyMap<string, string> = new Map()
): CanonicalEvent | null {
  const lookupRepo = (teamKey: string | null): string | undefined =>
    teamKey !== null ? teamsMap.get(teamKey) : undefined;

  switch (event.kind) {
    case "issue": {
      const attrs: Omit<Attributes, "event.name"> = {};
      if (event.ticket !== null) attrs["linear.issue.identifier"] = event.ticket;
      if (event.teamKey !== null) attrs["linear.team.key"] = event.teamKey;
      if (event.actorId !== null) attrs["linear.actor.id"] = event.actorId;
      if (event.issueId !== null) attrs["linear.issue.id"] = event.issueId; // CTL-822
      const repo = lookupRepo(event.teamKey);
      if (repo !== undefined) attrs["vcs.repository.name"] = repo;
      return canonical({
        ts,
        eventName: event.topic,
        entity: "issue",
        action: event.topic.replace(/^linear\.issue\./, ""),
        label: event.ticket ?? undefined,
        severity: "INFO",
        attrs,
        message: `${event.topic}${event.ticket ? ` ${event.ticket}` : ""}`,
        payload: {
          action: event.action,
          ticket: event.ticket,
          teamKey: event.teamKey,
          issueId: event.issueId, // CTL-822 — the only key a `remove` payload carries
          updatedFromKeys: event.updatedFromKeys,
          actorId: event.actorId,
          actorName: event.actorName,
          toState: event.toState,
          toPriority: event.toPriority,
          toAssigneeId: event.toAssigneeId,
          toAssigneeName: event.toAssigneeName,
          // CTL-681 — scoping fields the daemon's eligibleQuery needs. The
          // pre-CTL-681 envelope dropped these and forced a full poll per event.
          toLabels: event.toLabels,
          toProject: event.toProject,
          toProjectId: event.toProjectId,
          previousFromValues: event.previousFromValues,
          description: event.description,           // CTL-749
          descriptionChanged: event.descriptionChanged, // CTL-749
          toEstimate: event.toEstimate,            // CTL-957
          toDelegateId: event.toDelegateId,        // CTL-1174 (undefined drops key from JSON)
        },
      });
    }
    case "comment": {
      const eventName = `linear.comment.${event.action}d`;
      const attrs: Omit<Attributes, "event.name"> = {};
      if (event.ticket !== null) attrs["linear.issue.identifier"] = event.ticket;
      if (event.authorId !== null) attrs["linear.actor.id"] = event.authorId; // CTL-681
      // Comments don't carry team data directly — derive from the ticket prefix
      // so we can both stamp linear.team.key and look up vcs.repository.name.
      const derivedTeamKey = deriveTeamKey(event.ticket);
      const repo = lookupRepo(derivedTeamKey);
      if (repo !== undefined) {
        attrs["vcs.repository.name"] = repo;
        if (derivedTeamKey !== null) attrs["linear.team.key"] = derivedTeamKey;
      }
      return canonical({
        ts,
        eventName,
        entity: "comment",
        action: `${event.action}d`,
        label: event.ticket ?? undefined,
        severity: "INFO",
        attrs,
        message: `${eventName}${event.ticket ? ` on ${event.ticket}` : ""}`,
        payload: {
          action: event.action,
          commentId: event.commentId,
          issueId: event.issueId,
          ticket: event.ticket,
          body: event.body,            // CTL-681
          authorId: event.authorId,    // CTL-681
          authorName: event.authorName, // CTL-681
        },
      });
    }
    case "cycle": {
      const eventName = `linear.cycle.${event.action}d`;
      const attrs: Omit<Attributes, "event.name"> = {};
      if (event.teamKey !== null) attrs["linear.team.key"] = event.teamKey;
      const repo = lookupRepo(event.teamKey);
      if (repo !== undefined) attrs["vcs.repository.name"] = repo;
      return canonical({
        ts,
        eventName,
        entity: "cycle",
        action: `${event.action}d`,
        severity: "INFO",
        attrs,
        message: eventName,
        payload: {
          action: event.action,
          cycleId: event.cycleId,
          teamKey: event.teamKey,
        },
      });
    }
    case "reaction": {
      const eventName = `linear.reaction.${event.action}d`;
      return canonical({
        ts,
        eventName,
        entity: "reaction",
        action: `${event.action}d`,
        severity: "INFO",
        attrs: {},
        message: eventName,
        payload: {
          action: event.action,
          reactionId: event.reactionId,
        },
      });
    }
    case "issue_label": {
      const eventName = `linear.issue_label.${event.action}d`;
      return canonical({
        ts,
        eventName,
        entity: "issue_label",
        action: `${event.action}d`,
        severity: "INFO",
        attrs: {},
        message: eventName,
        payload: {
          action: event.action,
          labelId: event.labelId,
        },
      });
    }
    case "agent_session": {
      const eventName = `linear.agent_session.${event.action}d`;
      const attrs: Omit<Attributes, "event.name"> = {};
      if (event.actorId !== null) attrs["linear.actor.id"] = event.actorId;
      if (event.issueId !== null) attrs["linear.issue.id"] = event.issueId;
      return canonical({
        ts,
        eventName,
        entity: "agent_session",
        action: `${event.action}d`,
        severity: "INFO",
        attrs,
        message: eventName,
        payload: {
          action: event.action,
          sessionId: event.sessionId,
          issueId: event.issueId,
          actorId: event.actorId,
        },
      });
    }
    case "mention": {
      const eventName = `linear.mention.${event.action}d`;
      const attrs: Omit<Attributes, "event.name"> = {};
      if (event.ticket !== null) attrs["linear.issue.identifier"] = event.ticket;
      if (event.authorId !== null) attrs["linear.actor.id"] = event.authorId;
      const derivedTeamKey = deriveTeamKey(event.ticket);
      const repo = lookupRepo(derivedTeamKey);
      if (repo !== undefined) {
        attrs["vcs.repository.name"] = repo;
        if (derivedTeamKey !== null) attrs["linear.team.key"] = derivedTeamKey;
      }
      return canonical({
        ts,
        eventName,
        entity: "mention",
        action: `${event.action}d`,
        label: event.ticket ?? undefined,
        severity: "INFO",
        attrs,
        message: `${eventName}${event.ticket ? ` on ${event.ticket}` : ""}`,
        payload: {
          action: event.action,
          commentId: event.commentId,
          issueId: event.issueId,
          ticket: event.ticket,
          body: event.body,
          authorId: event.authorId,
          authorName: event.authorName,
        },
      });
    }
    case "ignored":
      return null;
  }
}

export function createLinearWebhookHandler(deps: LinearWebhookHandlerDeps): LinearWebhookHandler {
  const idempotencyMax = deps.idempotencyMax ?? 1000;
  const seenDeliveries: string[] = [];
  const seenDeliveriesSet = new Set<string>();
  const logger = deps.logger ?? {};
  // CTL-362: build the team→repo lookup once at construction so every webhook
  // call shares the same map without re-parsing.
  const teamsMap: ReadonlyMap<string, string> = new Map(
    (deps.linearTeams ?? []).map((t) => [t.key, t.vcsRepo])
  );

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
    if (deps.linearSecrets.length === 0) {
      return new Response("linear webhook secrets not configured", {
        status: 503,
      });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const rawBody = new Uint8Array(await req.arrayBuffer());
    const sig = req.headers.get("linear-signature");

    let verified = false;
    for (const { secret } of deps.linearSecrets) {
      if (secret && verifyLinearSignature(secret, rawBody, sig)) {
        verified = true;
        break;
      }
    }
    if (!verified) {
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
        `[linear-webhook] body parse failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return new Response("invalid json body", { status: 400 });
    }

    const event = parseLinearWebhookEvent(eventName, payload);

    // Bot-skip: suppress issue events authored by any known catalyst bot actor
    // to prevent write loops. botUserIds accepts ReadonlySet<string> or string.
    const _isBotActor = (ids: ReadonlySet<string> | string | undefined, id: string | null): boolean => {
      if (!ids || !id) return false;
      if (typeof ids === "string") return ids === id;
      return ids.has(id);
    };
    if (
      event.kind === "issue" &&
      _isBotActor(deps.botUserIds, event.actorId)
    ) {
      logger.info?.(
        `[linear-webhook] suppressed bot-authored issue event for ${event.ticket ?? "unknown"}`
      );
      return new Response(JSON.stringify({ ok: true, kind: event.kind }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (deps.eventLog && event.kind !== "ignored") {
      const envelope = buildLinearEventLogEnvelope(event, undefined, teamsMap);
      if (envelope !== null) {
        try {
          await deps.eventLog.append(envelope);
        } catch (err) {
          logger.warn?.(
            `[linear-webhook] event-log append failed: ${
              err instanceof Error ? err.message : String(err)
            }`
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
          }`
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
