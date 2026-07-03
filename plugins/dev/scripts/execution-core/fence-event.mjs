// fence-event.mjs — Linear-free, breaker-free fence event emitter (CTL-863,
// durable fence → event-log migration).
//
// The fence datum ({owner_host, catalyst_generation, phase, claimed_at}) used to
// live ONLY as a Linear attachment (cluster-claim.mjs::UpsertFence), read back on
// the hot path via `query ReadFence` — ~5,000 reads/hr that saturated the shared
// app-actor bucket and tripped the CTL-679 breaker (the CTL-1420 admission
// freeze). This module makes the fence WRITE a local, append-only event-log line
// that the broker projects into ticket_state's fence columns — the same durable
// projection the daemon already reads via gateway-read.mjs.
//
// HARD INVARIANT (spec §B / finding 8, OQ-D): the emit path is a plain
// `appendFileSync` to the canonical event log. It imports NO Linear client, NO
// linear-breaker, and touches NO app-actor bucket. A fence re-emit must NEVER be
// gated behind the Linear breaker-skip (that would re-create CTL-1420 on the
// fence path). This file's imports are grep-asserted in fence-event.test.mjs.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

// defaultAppend — write one JSONL line to the canonical event log (local disk
// only; identical convention to triage-transition-event.mjs::defaultAppend).
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildFenceEvent — canonical JSONL line (string + "\n") for a fence lifecycle
// event. action is "claimed" (a claim/takeover win or heartbeat re-emit) or
// "released" (owner dropped). A `released` event carries owner_host:null so the
// broker fold CLEARS the projection → the guard reads "not self-owned" → suppress
// (fail-closed, never allow — resolves OQ-F).
//
// `now`/`newId`/`newTrace`/`newSpan` are injectable so tests get a deterministic
// envelope.
export function buildFenceEvent(
  {
    ticket,
    action = "claimed", // "claimed" | "released"
    owner_host = null,
    generation = null,
    phase = null,
    claimed_at = null,
  } = {},
  {
    now = () => new Date(),
    newId = () => randomBytes(8).toString("hex"),
    newTrace = () => randomBytes(16).toString("hex"),
    newSpan = () => randomBytes(8).toString("hex"),
  } = {},
) {
  if (!ticket) throw new Error("buildFenceEvent: ticket is required");
  if (action !== "claimed" && action !== "released") {
    throw new Error(`buildFenceEvent: invalid action "${action}"`);
  }
  const ts = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const claimedAt = action === "released" ? null : (claimed_at ?? ts);
  const ownerHost = action === "released" ? null : owner_host;
  const gen = action === "released" ? null : generation;
  return (
    JSON.stringify({
      ts,
      id: newId(),
      observedTs: ts,
      severityText: "INFO",
      severityNumber: 9,
      traceId: newTrace(),
      spanId: newSpan(),
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": `fence.${action}.${ticket}`,
        "event.entity": "fence",
        "event.action": action,
        "event.label": ticket,
        "linear.issue.identifier": ticket,
        "catalyst.host.name": ownerHost,
      },
      body: {
        // The broker fold (router.mjs::projectFenceEvent) reads these keys.
        payload: {
          ticket,
          owner_host: ownerHost,
          generation: gen,
          phase: action === "released" ? null : phase,
          claimed_at: claimedAt,
        },
      },
    }) + "\n"
  );
}

// appendFenceEvent — build + append a fence event. Returns true on success,
// false on any error (logged + swallowed). NEVER throws — a fence-log write must
// not crash the tick. `append`/`build` are injectable for tests.
export function appendFenceEvent({ append = defaultAppend, build = buildFenceEvent, ...fields } = {}) {
  try {
    append(build(fields));
    return true;
  } catch (err) {
    log.error({ err: err?.message, ticket: fields?.ticket }, "fence-event: append failed");
    return false;
  }
}

// emitFenceClaimed / emitFenceReleased — thin intent-named wrappers so call sites
// read clearly. Both are Linear-free local appends.
export function emitFenceClaimed({ ticket, owner_host, generation, phase, claimed_at } = {}, opts = {}) {
  return appendFenceEvent({ ticket, action: "claimed", owner_host, generation, phase, claimed_at, ...opts });
}

export function emitFenceReleased({ ticket } = {}, opts = {}) {
  return appendFenceEvent({ ticket, action: "released", ...opts });
}
