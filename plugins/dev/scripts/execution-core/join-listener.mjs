// join-listener.mjs — CTL-1183. Armed single-use join-bundle listener.
// Security core: one-time bearer token, TTL, consume-on-first-200, PID-file lifecycle.

import { writeFileSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { assembleJoinBundle } from "./join-bundle.mjs";

export const JOIN_ROUTE = "/join-bundle";

export function makeListenerState({ token, ttlMs, nowMs }) {
  return { token, expiresAt: nowMs + ttlMs, consumed: false };
}

// timingSafeEqual requires same-length buffers; pad shorter to avoid length leak.
function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  // Use the longer length to avoid length-based oracle.
  const len = Math.max(presented.length, expected.length, 1);
  const ba = Buffer.alloc(len);
  const bb = Buffer.alloc(len);
  Buffer.from(presented).copy(ba);
  Buffer.from(expected).copy(bb);
  return timingSafeEqual(ba, bb) && presented.length === expected.length;
}

// Pure: returns { status, response, consume, ranAssembler, logFields }.
// Never logs the response body or the raw token.
export function handleJoinRequest(req, state, nowMs) {
  const url = new URL(req.url);
  const authHeader = req.headers.get("authorization") || "";
  const presented = authHeader.replace(/^Bearer\s+/i, "");
  const logFields = (status) => ({
    method: req.method,
    path: url.pathname,
    status,
    token: "[REDACTED]",
  });

  if (url.pathname !== JOIN_ROUTE) {
    return {
      status: 404,
      response: new Response("not found", { status: 404 }),
      consume: false,
      ranAssembler: false,
      logFields: logFields(404),
    };
  }

  if (
    state.consumed ||
    nowMs >= state.expiresAt ||
    !tokenMatches(presented, state.token)
  ) {
    return {
      status: 401,
      response: new Response("unauthorized", { status: 401 }),
      consume: false,
      ranAssembler: false,
      logFields: logFields(401),
    };
  }

  // Single-use latch set BEFORE assembling the bundle.
  state.consumed = true;
  const bundle = assembleJoinBundle();
  return {
    status: 200,
    response: new Response(JSON.stringify(bundle), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    consume: true,
    ranAssembler: true,
    logFields: logFields(200),
  };
}

// Thin runner. Returns { url, token, pidFile, stop }.
export function startArmedListener({
  port = 7401,
  hostname = "0.0.0.0",
  token,
  ttlMs = 15 * 60_000,
  pidFile = `${process.env.CATALYST_DIR || `${process.env.HOME}/catalyst`}/join-bundle-listener.pid`,
  log = console.error,
} = {}) {
  const state = makeListenerState({ token, ttlMs, nowMs: Date.now() });
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
    server.stop(true);
  };

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    fetch(req) {
      const r = handleJoinRequest(req, state, Date.now());
      log(JSON.stringify(r.logFields));
      if (r.consume) setTimeout(() => stop(), 50);
      return r.response;
    },
  });

  writeFileSync(pidFile, `${process.pid}\n`);

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      stop();
      process.exit(0);
    });
  }

  const listenHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  return {
    url: `http://${listenHost}:${server.port}${JOIN_ROUTE}`,
    token,
    pidFile,
    stop,
  };
}

// CLI entrypoint: `bun run join-listener.mjs` reads token/ttl/port from env.
if (import.meta.main) {
  const { url } = startArmedListener({
    port: Number(process.env.CATALYST_JOIN_LISTENER_PORT) || 7401,
    token: process.env.CATALYST_JOIN_TOKEN,
    ttlMs: (Number(process.env.CATALYST_JOIN_TTL_MIN) || 15) * 60_000,
  });
  console.error(`armed join-bundle listener: ${url}`);
}
