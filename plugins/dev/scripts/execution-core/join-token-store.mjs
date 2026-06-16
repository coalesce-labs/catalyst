#!/usr/bin/env node
// join-token-store.mjs — shared single-use join-token store (CTL-1184).
//
// The SEAM between CTL-1184 (mint + arm, this module's writers) and CTL-1183
// (the short-lived bundle listener, which imports verifyToken/consumeToken/
// disarm). The token is an on-disk bearer secret — NEVER committed, mode 0600,
// under ${catalystDir()}/cluster/join-token.json. The CLI process mints then
// exits; the listener is a separate process, so the store cannot be in-memory.
//
// Model: k3s node-token — short-TTL, single-use, consumed server-side on the
// first successful bundle fetch (design §2.5).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min — k3s node-token default model

// Re-resolved per call so tests redirect via CATALYST_DIR (mirrors config.mjs:64).
function catalystDir() {
  return process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
}
function clusterDir() {
  return resolve(catalystDir(), "cluster");
}
export function storePath() {
  return resolve(clusterDir(), "join-token.json");
}

function resolveTtlMs(explicit) {
  if (typeof explicit === "number") return explicit;
  const env = process.env.CATALYST_JOIN_TOKEN_TTL_MS;
  if (env !== undefined && env !== "" && Number.isFinite(Number(env))) return Number(env);
  return DEFAULT_TTL_MS;
}

export function mintToken(opts = {}) {
  const token = "jt_" + randomBytes(32).toString("hex");
  const ttlMs = resolveTtlMs(opts.ttlMs);
  const mintedAt = Date.now();
  const rec = { token, mintedAt, ttlMs, consumed: false };
  mkdirSync(clusterDir(), { recursive: true });
  // Atomic-ish write then tighten perms (umask-independent).
  writeFileSync(storePath(), JSON.stringify(rec), { mode: 0o600 });
  return { token, mintedAt, ttlMs, expiresAt: mintedAt + ttlMs };
}

export function readToken() {
  try {
    const raw = readFileSync(storePath(), "utf8");
    const rec = JSON.parse(raw);
    if (typeof rec?.token !== "string") return null;
    return rec;
  } catch {
    return null; // absent or malformed
  }
}

function isExpired(rec) {
  return Date.now() - rec.mintedAt >= rec.ttlMs;
}

export function isArmed() {
  const rec = readToken();
  return !!rec && rec.consumed !== true && !isExpired(rec);
}

export function verifyToken(tok) {
  if (typeof tok !== "string" || tok.length === 0) return false;
  const rec = readToken();
  if (!rec || typeof rec.token !== "string") return false;
  const a = Buffer.from(tok);
  const b = Buffer.from(rec.token);
  if (a.length !== b.length) return false; // length-guard (webhook-verify.ts:19)
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function consumeToken(tok) {
  if (!isArmed()) return null;
  if (!verifyToken(tok)) return null;
  const rec = readToken();
  rec.consumed = true;
  rec.consumedAt = Date.now();
  writeFileSync(storePath(), JSON.stringify(rec), { mode: 0o600 });
  return rec;
}

export function disarm() {
  try {
    if (existsSync(storePath())) rmSync(storePath());
  } catch {
    /* best-effort */
  }
}

// CLI entrypoint: `node join-token-store.mjs mint` prints the record as JSON.
// The bash CLI (catalyst-cluster) shells out to this so token generation +
// crypto live in one place. Uses suffix-check idiom (not bun-only
// import.meta.main) so it works under both bun and node (see claim.mjs:131).
if (
  process.argv[1] &&
  (process.argv[1].endsWith("/join-token-store.mjs") ||
    process.argv[1].endsWith("join-token-store.mjs"))
) {
  const cmd = process.argv[2];
  if (cmd === "mint") {
    process.stdout.write(JSON.stringify(mintToken()) + "\n");
  } else {
    process.stderr.write("usage: join-token-store.mjs mint\n");
    process.exit(2);
  }
}
