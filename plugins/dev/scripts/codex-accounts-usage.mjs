#!/usr/bin/env node
// codex-accounts-usage.mjs — report, per provisioned Codex account: the email,
// plan, every rate-limit window's used-% and reset, which account is ACTIVE, and
// whether this host can actually use it.
//
// WHY THE APP-SERVER PATH (and not the private usage endpoint):
// The Claude twin (claude-accounts-usage.mjs) has to spend one max_tokens:1
// inference call per account, because a durable setup-token 403s the account
// usage API and only /v1/messages carries the rate-limit headers. Codex is not
// like that: `codex app-server` exposes a DOCUMENTED account plane that answers
// `account/read` and `account/rateLimits/read` for FREE. Reading every account
// costs ZERO TOKENS and makes no inference call. Scraping
// chatgpt.com/backend-api or parsing auth.json token values is explicitly not
// done — it is unsupported, and the supported plane already returns the email
// and planType those paths would have to scrape.
//
// ⛔ WINDOWS ARE NAMED FROM windowDurationMins, NEVER FROM POSITION.
// Measured on mini-2 (codex-cli 0.147.0, 2026-08-22): the top-level `codex`
// bucket's `primary` is a WEEKLY window with `secondary: null`, while a real
// 5-hour window exists only under a different bucket (`codex_bengalfox`). The
// naive positional {primary->fiveHour, secondary->sevenDay} port of the Claude
// shape would mislabel the weekly window as 5h AND report the 5h window as
// absent — both in the direction that reads as "quota to spare". See
// lib/codex-account-plane.mjs.
//
// SECRETS HYGIENE (hard rule): this tool never reads, prints, or logs any token
// or refresh material. It only ever spawns the app-server with CODEX_HOME set
// and renders the fields that plane returns. `auth.json` is stat'd for presence
// and NEVER read. NEVER print a credential.
//
// Usage:
//   node codex-accounts-usage.mjs            # human-readable table
//   node codex-accounts-usage.mjs --json     # machine-readable JSON
//   CATALYST_CODEX_ROOT=/path  node codex-accounts-usage.mjs   # discovery root
//   CATALYST_CODEX_BIN=/path/to/codex  node codex-accounts-usage.mjs
//
// Exit code: 0 if at least one account reported limits (status ok); 1 if none could.

import { hostname } from "node:os";
import { resolve } from "node:path";
import { discoverCodexHomes, readAccountPlane } from "./lib/codex-account-client.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

function defaultRoot() {
  return process.env.CATALYST_CODEX_ROOT
    ? resolve(process.env.CATALYST_CODEX_ROOT)
    : resolve(process.env.HOME ?? "", "catalyst");
}

// ---- formatting helpers (human output) ----

function fmtRelative(epochSeconds, nowMs) {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return "?";
  const delta = epochSeconds * 1000 - nowMs;
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

function fmtReset(epochSeconds, nowMs) {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return "—";
  const local = new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${local} (in ${fmtRelative(epochSeconds, nowMs)})`;
}

function renderHuman(envelope, nowMs) {
  const lines = [];
  const sel = envelope.selector;
  lines.push(`Codex accounts on ${envelope.host}`);
  lines.push(
    `Selector: ${sel.path} [${sel.kind}]` +
      (sel.activeHandle ? ` -> ${sel.activeHandle}` : " -> (none)"),
  );
  if (sel.kind === "directory") {
    lines.push(
      "  ⚠ the selector is a real directory, not a symlink — this host is PINNED and",
      "    `catalyst-stack codex-account switch` will refuse until it is converted.",
    );
  }
  lines.push("");

  for (const a of envelope.accounts) {
    const marker = a.isActive ? "* " : "  ";
    const who = a.email ?? "(no email)";
    const plan = a.planType ? ` ${a.planType}` : "";
    lines.push(`${marker}${a.label}  ${who}${plan}  [${a.status}]`);
    if (a.reason) lines.push(`      reason: ${a.reason}`);
    if (a.accountType && a.accountType !== "chatgpt") {
      lines.push(`      account type: ${a.accountType}`);
    }
    for (const bucket of a.buckets) {
      const name = bucket.limitName ? `${bucket.limitId} (${bucket.limitName})` : bucket.limitId;
      if (bucket.windows.length === 0) {
        lines.push(`      ${name}: no window reported`);
        continue;
      }
      for (const w of bucket.windows) {
        const bind =
          a.binding && a.binding.limitId === bucket.limitId && a.binding.label === w.label
            ? "  <- binding"
            : "";
        lines.push(
          `      ${name} ${w.label}: ${w.usedPercent}% used, resets ${fmtReset(w.resetsAt, nowMs)}${bind}`,
        );
      }
    }
    lines.push("");
  }

  if (envelope.accounts.length === 0) {
    lines.push("  (no codex-home-acctN directories found under the discovery root)");
  }
  return lines.join("\n");
}

async function main() {
  const root = defaultRoot();
  const discovery = discoverCodexHomes(root);
  const bin = process.env.CATALYST_CODEX_BIN || "codex";

  // Read every home SEQUENTIALLY — one short-lived child at a time. There is no
  // need to race two ~1-2s reads, and sequential keeps the output deterministic.
  const accounts = [];
  for (const acct of discovery.accounts) {
    const verdict = await readAccountPlane({ codexHome: acct.path, bin });
    accounts.push({
      label: acct.handle,
      isActive: discovery.activeHandle === acct.handle,
      codexHome: acct.path,
      hasAuth: acct.hasAuth,
      email: verdict.email,
      planType: verdict.planType,
      accountType: verdict.accountType,
      status: verdict.status,
      reason: verdict.reason,
      binding: verdict.binding,
      buckets: verdict.buckets,
    });
  }

  const nowMs = Date.now();
  const envelope = {
    generatedAt: new Date(nowMs).toISOString(),
    host: hostname(),
    root,
    selector: {
      kind: discovery.selectorKind,
      path: discovery.selectorPath,
      target: discovery.selectorTarget,
      activeHandle: discovery.activeHandle,
    },
    accounts,
  };

  if (asJson) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    console.log(renderHuman(envelope, nowMs));
  }

  // ⛔ Zero accounts is NOT a clean pass. `[].some(p)` is false, which lands on
  // exit 1 here by construction — but state it explicitly so a future edit
  // cannot turn "I found nothing to look at" into "everything is fine".
  if (accounts.length === 0) {
    console.error(
      `codex-accounts-usage: no codex-home-acct* directories under ${root} — nothing could be read (set CATALYST_CODEX_ROOT to override).`,
    );
    process.exit(1);
  }
  process.exit(accounts.some((a) => a.status === "ok") ? 0 : 1);
}

main().catch((err) => {
  console.error(`codex-accounts-usage: ${err?.message ?? err}`);
  process.exit(1);
});
