#!/usr/bin/env node
// claude-accounts-usage.mjs — read every durable Claude OAuth token in
// claude-accounts.env and report, per subscription account: the email and each
// rate-limit window's utilization + reset time + status.
//
// WHY THE INFERENCE PATH (not /api/oauth/usage):
// The account usage API (GET /api/oauth/usage, /api/oauth/profile) only answers
// to an *interactive-login* subscription token (the one `claude /login` writes to
// the macOS Keychain / ~/.claude/.credentials.json). The DURABLE `setup-token`s
// (sk-ant-oat…) in claude-accounts.env are inference-scoped and get a 403 there
// (verified: same account, login token → 200, setup-token → 403). But they CAN
// make inference calls, and every /v1/messages response carries the
// `anthropic-ratelimit-unified-*` headers with the live 5h / 7d utilization,
// reset epoch, and status. So this tool spends one tiny (max_tokens:1, Haiku)
// call per account and reads its limits from the response headers — the only
// mechanism that works for a durable token. Header utilization is a fraction of
// 1 (0.06 → 6%); reset is unix-epoch seconds. Both calibrated against /usage.
//
// The account email is NOT available from a setup-token (profile 403s it), so it
// is read from the inline comment each token line carries
// (`CLAUDE_TOKEN_acctN='…'  # name@domain`).
//
// SECRETS HYGIENE (hard rule): OAuth tokens are read into local variables and
// used as bearer credentials only. They are NEVER printed, logged, or placed in
// any output. The active-account match compares values in memory. NEVER print a
// token.
//
// Usage:
//   node claude-accounts-usage.mjs            # human-readable table
//   node claude-accounts-usage.mjs --json     # machine-readable JSON
//   CLAUDE_ACCOUNTS_ENV=/path/to/file node claude-accounts-usage.mjs
//
// Exit code: 0 if at least one account reported limits; 1 if none could.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_ENV_PATH = resolve(homedir(), ".config", "catalyst", "claude-accounts.env");
const MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_VERSION = "2023-06-01";
// Cheapest model + the Claude Code system-prompt prefix the OAuth path requires.
const PROBE_MODEL = "claude-haiku-4-5-20251001";
const PROBE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
// Inter-account spacing — keeps a multi-account sweep clear of any shared limiter.
const INTER_ACCOUNT_DELAY_MS = 500;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// getUserAgent — REQUIRED header; a wrong/missing UA can trigger an instant 429.
// Built from the locally-installed claude version.
function getUserAgent() {
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf8" });
    return `claude-code/${String(out).trim().split(/\s+/)[0] || "unknown"}`;
  } catch {
    return "claude-code/unknown";
  }
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// parseAssignment — split a `KEY=VALUE` RHS into { token, comment } exactly as a
// POSIX shell would when sourcing the file: a quoted value runs to its matching
// close quote; an unquoted value runs to the first whitespace; the remainder is
// the inline comment (which carries the account email here). We do NOT evaluate
// the file, so this mirror keeps the parsed token identical to `source`-ing it.
function parseAssignment(rhs) {
  const s = rhs.trimStart();
  let token = "";
  let rest = "";
  if (s[0] === "'" || s[0] === '"') {
    const q = s[0];
    const end = s.indexOf(q, 1);
    if (end === -1) {
      token = s.slice(1);
    } else {
      token = s.slice(1, end);
      rest = s.slice(end + 1);
    }
  } else {
    const m = s.match(/^(\S+)(.*)$/);
    token = m ? m[1] : s;
    rest = m ? m[2] : "";
  }
  const comment = rest.replace(/^\s*#?\s*/, "").trim();
  return { token: token.trim(), comment };
}

// parseAccountsEnv — extract every `CLAUDE_TOKEN_<label>=<token>` assignment.
function parseAccountsEnv(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { accounts: [], missing: true };
    throw err;
  }
  const accounts = [];
  const re = /^(?:export\s+)?CLAUDE_TOKEN_([A-Za-z0-9_]+)=(.*)$/;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(re);
    if (!m) continue;
    const { token, comment } = parseAssignment(m[2]);
    if (!token || token === "PASTE_TOKEN_HERE") continue;
    accounts.push({ label: m[1], token, commentEmail: comment.match(EMAIL_RE)?.[0] ?? null });
  }
  return { accounts, missing: false };
}

// fetchUnifiedLimits — make one minimal inference call and read the rate-limit
// state from the `anthropic-ratelimit-unified-*` response headers. Returns
// { status, headers } where headers is the parsed unified block (null on a
// non-200/non-429 failure). NEVER throws.
async function fetchUnifiedLimits(token, userAgent, fetchImpl = fetch) {
  const body = JSON.stringify({
    model: PROBE_MODEL,
    max_tokens: 1,
    system: PROBE_SYSTEM,
    messages: [{ role: "user", content: "hi" }],
  });
  let res;
  try {
    res = await fetchImpl(MESSAGES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "User-Agent": userAgent,
      },
      body,
    });
  } catch {
    return { status: 0, headers: null };
  }
  // Even a 429 carries the unified headers (status: rejected), so parse them
  // whenever they are present.
  const h = res.headers;
  const num = (k) => {
    const v = h.get(k);
    return v == null || v === "" ? null : Number(v);
  };
  const epochToIso = (k) => {
    const v = num(k);
    return v == null || !Number.isFinite(v) ? null : new Date(v * 1000).toISOString();
  };
  const has = h.get("anthropic-ratelimit-unified-status") != null;
  if (!has) return { status: res.status, headers: null };
  // utilization headers are fractions of 1 → ×100 for percent (rounded to 0.1).
  const pct = (k) => {
    const v = num(k);
    return v == null ? null : Math.round(v * 1000) / 10;
  };
  return {
    status: res.status,
    headers: {
      overallStatus: h.get("anthropic-ratelimit-unified-status"),
      representativeClaim: h.get("anthropic-ratelimit-unified-representative-claim"),
      fiveHourPct: pct("anthropic-ratelimit-unified-5h-utilization"),
      fiveHourResetsAt: epochToIso("anthropic-ratelimit-unified-5h-reset"),
      fiveHourStatus: h.get("anthropic-ratelimit-unified-5h-status"),
      sevenDayPct: pct("anthropic-ratelimit-unified-7d-utilization"),
      sevenDayResetsAt: epochToIso("anthropic-ratelimit-unified-7d-reset"),
      sevenDayStatus: h.get("anthropic-ratelimit-unified-7d-status"),
    },
  };
}

// gatherAccount — resolve one account into a plain, token-free result record.
async function gatherAccount({ label, token, isActive, commentEmail }, userAgent) {
  const base = {
    label,
    isActive: Boolean(isActive),
    email: commentEmail ?? null,
    overallStatus: null,
    representativeClaim: null,
    fiveHour: null,
    sevenDay: null,
    error: null,
  };

  const { status, headers } = await fetchUnifiedLimits(token, userAgent);
  if (status === 401 || status === 403) {
    base.error = `auth failed (${status}) — token invalid, expired, or lacks inference scope`;
    return base;
  }
  if (!headers) {
    base.error = status === 0 ? "network error" : `no rate-limit headers (HTTP ${status})`;
    return base;
  }
  base.overallStatus = headers.overallStatus;
  base.representativeClaim = headers.representativeClaim;
  base.fiveHour =
    headers.fiveHourPct == null
      ? null
      : { pct: headers.fiveHourPct, resetsAt: headers.fiveHourResetsAt, status: headers.fiveHourStatus };
  base.sevenDay =
    headers.sevenDayPct == null
      ? null
      : { pct: headers.sevenDayPct, resetsAt: headers.sevenDayResetsAt, status: headers.sevenDayStatus };
  return base;
}

// ---- formatting helpers (human output) ----

function fmtRelative(resetsAtIso, nowMs) {
  const ms = Date.parse(resetsAtIso);
  if (!Number.isFinite(ms)) return "?";
  const delta = ms - nowMs;
  if (delta <= 0) return "now";
  const mins = Math.round(delta / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function fmtReset(resetsAtIso, nowMs) {
  if (!resetsAtIso) return "—";
  const ms = Date.parse(resetsAtIso);
  if (!Number.isFinite(ms)) return resetsAtIso;
  const local = new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${local} (in ${fmtRelative(resetsAtIso, nowMs)})`;
}

function bar(pct, width = 20) {
  if (pct == null) return `[${" ".repeat(width)}]  n/a`;
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const used = Math.round(clamped);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]  ${String(used).padStart(3)}% used · ${Math.max(0, 100 - used)}% left`;
}

const STATUS_MARK = { allowed: "✓", allowed_warning: "⚠", rejected: "✗" };

function windowLine(name, b, nowMs) {
  if (b == null) return `    ${name.padEnd(14)} no usage`;
  const mark = STATUS_MARK[b.status] ?? "";
  return `    ${name.padEnd(14)} ${bar(b.pct)}  ${mark}  resets ${fmtReset(b.resetsAt, nowMs)}`;
}

function renderHuman(results, nowMs) {
  const lines = ["", "Claude account usage", "════════════════════"];
  for (const r of results) {
    const who = r.email || `(unknown — env key ${r.label})`;
    const flags = [];
    if (r.isActive) flags.push("ACTIVE");
    if (r.overallStatus && r.overallStatus !== "allowed") flags.push(r.overallStatus.toUpperCase());
    const tag = flags.length ? `   ${flags.join(" · ")}` : "";
    lines.push("", `● ${who}   [${r.label}]${tag}`);
    if (r.error) {
      lines.push(`    ⚠ ${r.error}`);
      continue;
    }
    lines.push(windowLine("5-hour", r.fiveHour, nowMs));
    lines.push(windowLine("7-day", r.sevenDay, nowMs));
    if (r.representativeClaim) {
      lines.push(`    binding window: ${r.representativeClaim === "five_hour" ? "5-hour" : r.representativeClaim === "seven_day" ? "7-day" : r.representativeClaim}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const envPath = process.env.CLAUDE_ACCOUNTS_ENV || DEFAULT_ENV_PATH;
  const { accounts, missing } = parseAccountsEnv(envPath);

  if (missing) {
    console.error(`No accounts file at ${envPath} (set CLAUDE_ACCOUNTS_ENV to override).`);
    process.exit(1);
  }
  if (accounts.length === 0) {
    console.error(`No CLAUDE_TOKEN_* tokens found in ${envPath}.`);
    process.exit(1);
  }

  // Mark the active account by value-matching the live env override (never printed).
  const activeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
  for (const a of accounts) a.isActive = activeToken != null && a.token === activeToken;

  const userAgent = getUserAgent();
  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) await sleep(INTER_ACCOUNT_DELAY_MS);
    results.push(await gatherAccount(accounts[i], userAgent));
  }

  const nowMs = Date.now();
  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date(nowMs).toISOString(), accounts: results }, null, 2));
  } else {
    console.log(renderHuman(results, nowMs));
  }

  process.exit(results.some((r) => r.fiveHour || r.sevenDay) ? 0 : 1);
}

main().catch((err) => {
  console.error(`claude-accounts-usage: ${err?.message ?? err}`);
  process.exit(1);
});
