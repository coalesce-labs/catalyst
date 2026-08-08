import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./config.mjs";
import { USAGE_LIMIT_FALLBACK_MS } from "./usage-limit.mjs";

export function laneCooldownPath(orchDir, lane) {
  return join(orchDir, ".lane-cooldowns", `${lane}.json`);
}
export function readLaneCooldown(orchDir, lane) {
  try {
    return JSON.parse(readFileSync(laneCooldownPath(orchDir, lane), "utf8"));
  } catch {
    return null;
  }
}
export function inLaneCooldown(orchDir, lane, now = Date.now()) {
  const marker = readLaneCooldown(orchDir, lane);
  return !!marker && typeof marker.expiresAt === "number" && now < marker.expiresAt;
}
export function parkLane(
  orchDir,
  lane,
  { resetsAt, detail = null, ticket = null, phase = null, now = Date.now() }
) {
  const requested = Date.parse(resetsAt);
  const expiresAt =
    Number.isFinite(requested) && requested > now ? requested : now + USAGE_LIMIT_FALLBACK_MS;
  const previous = readLaneCooldown(orchDir, lane);
  const marker = {
    lane,
    code: "usage-limit",
    blockedAt: now,
    expiresAt: Math.max(expiresAt, previous?.expiresAt ?? 0),
    detail,
    lastTicket: ticket,
    lastPhase: phase,
  };
  try {
    mkdirSync(dirname(laneCooldownPath(orchDir, lane)), { recursive: true });
    writeFileSync(laneCooldownPath(orchDir, lane), JSON.stringify(marker));
  } catch (err) {
    log.warn({ lane, err: err.message }, "cat-58: lane cool-down write failed — continuing");
  }
  return marker;
}
