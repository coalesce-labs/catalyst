//bin/true 2>/dev/null; exec 1>&2; echo "REFUSING: a SHELL is executing this JavaScript module — see CTL-1937."; exit 97
// cli/cluster-route.mjs — CTL-2116. `catalyst cluster route <verb>`.
//
// Guard order is load-bearing and copied from catalyst-stack's codex-account
// switch (catalyst-stack:4898-4936), which is the proven template:
//   1. cluster clone present                      (nothing to change otherwise)
//   2. clone is CLEAN                             (a bystander change must not ride the fleet commit)
//   3. git pull --ff-only                         (derive the prior value from what the FLEET has, not a stale local copy)
//   4. validate phase + executor                  (refuse BEFORE any write)
//   5. budget gate (Phase 5) for codex-adding changes
//   6. write → commit → push; roll the local commit back on a lost push race
//
// routeCommand is pure over its injected `deps` — no real git, no real cluster
// clone — so guard ORDERING (the load-bearing part) is testable without touching
// a repo. runRoute wires the real deps + prints + returns a process exit code.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  EXECUTORS,
  EXECUTOR_ALIASES,
  getClusterRepoDir,
  getHostName,
} from "../config.mjs";
import { readExecutorPolicy, applyRouteChange, rollbackPolicy } from "../executor-policy.mjs";
import {
  DEFAULT_CODEX_BUDGET_FLOOR_PERCENT,
  addsCodexLoad,
  classifyPolicyBudget,
} from "../executor-policy-budget.mjs";
import { discoverCodexHomes, readAccountPlane } from "../../lib/codex-account-client.mjs";
import {
  hasClusterRepo as clusterRepoPresent,
  writeClusterJson,
  commitAndPushCluster,
  defaultGit,
} from "./cluster.mjs";
import { defaultAppendOperatorEvent } from "../recovery.mjs";
import { KNOWN_PHASES } from "../../broker/namespace-contract.mjs";

const MUTATING_VERBS = new Set(["set", "clear", "all", "rollback"]);
const READ_VERBS = new Set(["show", "history"]);

function canonicalizeExecutor(raw) {
  const normalized = String(raw ?? "").trim().toLowerCase();
  return EXECUTOR_ALIASES[normalized] ?? normalized;
}

function isValidExecutor(raw) {
  return EXECUTORS.includes(canonicalizeExecutor(raw));
}

// formatRoutesForMessage — human-readable "was: …" clause for a commit message.
function formatRoutesForMessage(routes) {
  const entries = Object.entries(routes ?? {});
  if (entries.length === 0) return "unrouted";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function buildCommitMessage(verb, entry, by, host) {
  const attribution = `[by ${by ?? "unknown"} on ${host ?? "unknown"}]`;
  if (verb === "rollback") {
    return `chore(cluster): rollback routing policy to ${entry.rollbackOf ?? "(unknown)"} ${attribution}`;
  }
  if (entry.change.phase === "*") {
    return (
      `chore(cluster): route ALL phases -> ${entry.change.to ?? "unrouted"} ` +
      `(was: ${formatRoutesForMessage(entry.priorRoutes)}) ${attribution}`
    );
  }
  return (
    `chore(cluster): route ${entry.change.phase} -> ${entry.change.to ?? "unrouted"} ` +
    `(was: ${entry.change.from ?? "unrouted"}) ${attribution}`
  );
}

function parsePositional(rest) {
  return rest.filter((a) => !a.startsWith("-"));
}

// routeCommand — pure over `deps`. Returns a Promise<{ code, msg, json }> — ASYNC
// because the real `checkBudget` (Phase 5) spawns a `codex app-server` child per
// account (lib/codex-account-client.mjs). `await`ing a synchronous mock's plain
// return value is a no-op (Promise.resolve semantics), so every test that
// supplies a sync `checkBudget` is unaffected.
export async function routeCommand(argv = [], deps = {}) {
  const {
    clusterDir,
    hasClusterRepo = clusterRepoPresent,
    isDirty,
    pull,
    readPolicy,
    writePolicy,
    commitAndPush,
    checkBudget,
    by,
    host,
    at,
    emitEvent = () => {},
  } = deps;

  const [verb, ...rest] = argv;

  if (READ_VERBS.has(verb)) {
    const policy = readPolicy(clusterDir) ?? { routes: {}, history: [] };
    if (verb === "show") {
      return {
        code: 0,
        msg: "",
        json: {
          routes: policy.routes ?? {},
          updatedAt: policy.updatedAt ?? null,
          updatedBy: policy.updatedBy ?? null,
        },
      };
    }
    // history — newest-first, exactly as stored (applyRouteChange/rollbackPolicy
    // already unshift newest-first and bound at HISTORY_MAX).
    return { code: 0, msg: "", json: { history: policy.history ?? [] } };
  }

  if (!MUTATING_VERBS.has(verb)) {
    return { code: 2, msg: `catalyst cluster route: unknown verb '${verb ?? ""}'` };
  }

  // ── argv shape (verb-specific required args) — before any I/O ──────────────
  let phase = null;
  let executor = null;
  let all = false;
  if (verb === "set") {
    [phase, executor] = parsePositional(rest);
    if (!phase || !executor) {
      return { code: 2, msg: "catalyst cluster route set requires <phase> <executor>" };
    }
  } else if (verb === "clear") {
    [phase] = parsePositional(rest);
    executor = null;
    if (!phase) {
      return { code: 2, msg: "catalyst cluster route clear requires <phase>" };
    }
  } else if (verb === "all") {
    all = true;
    [executor] = parsePositional(rest);
    if (!executor) {
      return { code: 2, msg: "catalyst cluster route all requires <executor>" };
    }
    if (!rest.includes("--yes")) {
      return {
        code: 2,
        msg: "catalyst cluster route all requires --yes (fleet-wide blast radius)",
      };
    }
  }
  // rollback has no required positional args.

  // ── guard 1: cluster clone present ──────────────────────────────────────────
  if (!hasClusterRepo(clusterDir)) {
    return {
      code: 1,
      msg: `catalyst cluster route: no cluster-repo clone present at ${clusterDir ?? "(unset)"} — nothing to change`,
    };
  }

  // ── guard 2: clone is clean ──────────────────────────────────────────────────
  if (isDirty(clusterDir)) {
    return {
      code: 1,
      msg:
        "catalyst cluster route: the cluster-repo clone has uncommitted changes — refusing " +
        "(a bystander change would be pushed fleet-wide alongside the route change)",
    };
  }

  // ── guard 3: pull --ff-only BEFORE deriving the prior value ─────────────────
  const pullResult = pull(clusterDir);
  if (!pullResult?.ok) {
    return {
      code: 1,
      msg: `catalyst cluster route: git pull --ff-only failed (${pullResult?.err ?? "unknown error"}) — refusing to derive the prior value from a stale local copy`,
    };
  }

  // ── guard 4: validate phase + executor VALUES (post-pull, before any write) ─
  if ((verb === "set" || verb === "clear") && !KNOWN_PHASES.includes(phase)) {
    return {
      code: 2,
      msg: `catalyst cluster route: unknown phase '${phase}' — expected one of [${KNOWN_PHASES.join(", ")}]`,
    };
  }
  if ((verb === "set" || verb === "all") && !isValidExecutor(executor)) {
    return {
      code: 2,
      msg:
        `catalyst cluster route: '${executor}' is not a valid executor — ` +
        `expected one of [${EXECUTORS.join(", ")}] (aliases: ${Object.keys(EXECUTOR_ALIASES).join(", ")})`,
    };
  }

  const policy = readPolicy(clusterDir) ?? { routes: {}, history: [] };

  let result;
  if (verb === "rollback") {
    result = rollbackPolicy(policy, { by, host, at });
    if (!result.changed) {
      return { code: 1, msg: `catalyst cluster route rollback: refused (${result.reason})` };
    }
  } else {
    result = applyRouteChange(policy, { phase, all, executor, by, host, at });
    if (!result.changed) {
      return {
        code: 0,
        msg: "catalyst cluster route: already routed that way — no change",
        json: { routes: policy.routes ?? {} },
      };
    }
  }

  // ── guard 5: budget gate — ONLY for a codex-ADDING change ────────────────────
  // A change that removes or does not add Codex load is never gated (CTL-2116
  // Scenario 3's third Then). `checkBudget` is the injected verdict provider —
  // in production it wraps classifyPolicyBudget (executor-policy-budget.mjs)
  // over a live account read; tests inject a fixed verdict.
  const wouldAddCodexLoad = addsCodexLoad({
    priorRoutes: policy.routes ?? {},
    nextRoutes: result.next.routes ?? {},
  });
  if (wouldAddCodexLoad) {
    const verdict = await checkBudget();
    if (verdict?.verdict !== "allow") {
      const forced = rest.includes("--force");
      if (!forced) {
        // Scenario 3's second Then: the current policy is left UNCHANGED —
        // refuse before guard 6 ever writes/commits/pushes.
        return {
          code: 1,
          msg: verdict?.message
            ? `catalyst cluster route: REFUSED — routing would add Codex load, but ${verdict.message}\nThe current policy is unchanged. Override with --force (recorded in the audit history).`
            : `catalyst cluster route: REFUSED — Codex budget check returned '${verdict?.verdict}' (${verdict?.reason ?? "no reason given"}). The current policy is unchanged. Override with --force (recorded in the audit history).`,
        };
      }
      // --force overrides refuse/inconclusive — recorded on the entry so the
      // audit trail shows a human explicitly overrode the gate, not that the
      // gate silently passed.
      result.entry = { ...result.entry, forcedBudget: true };
      result.next = {
        ...result.next,
        history: [
          { ...result.next.history[0], forcedBudget: true },
          ...result.next.history.slice(1),
        ],
      };
    }
  }

  // ── guard 6: write → commit → push ───────────────────────────────────────────
  writePolicy(clusterDir, result.next);
  const message = buildCommitMessage(verb, result.entry, by, host);
  const sync = commitAndPush(clusterDir, result.next, message);
  if (!sync?.pushed) {
    return {
      code: 1,
      msg: `catalyst cluster route: committed but push failed${sync?.error ? ` (${sync.error})` : ""} — push manually so peers pick it up`,
    };
  }

  emitEvent({
    "event.name": "execution-core.executor.policy-changed",
    payload: {
      verb,
      phase: result.entry.change.phase,
      from: result.entry.change.from,
      to: result.entry.change.to,
      by,
      host,
      entryId: result.entry.id,
      routes: result.next.routes,
    },
  });

  return { code: 0, msg: message, json: { routes: result.next.routes } };
}

// ── runRoute — wires real deps, prints, returns a process exit code ──────────

function defaultIsDirty(clusterDir) {
  try {
    const out = execFileSync("git", ["-C", clusterDir, "status", "--porcelain"], {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return true; // can't confirm clean → refuse rather than risk a bystander push
  }
}

function defaultPull(clusterDir) {
  try {
    execFileSync("git", ["-C", clusterDir, "pull", "--ff-only"], { encoding: "utf8" });
    return { ok: true };
  } catch (err) {
    return { ok: false, err: err?.message ?? String(err) };
  }
}

function defaultWritePolicy(clusterDir, next) {
  writeClusterJson(clusterDir, { executorPolicy: next });
}

function defaultCommitAndPush(clusterDir, _next, message) {
  return commitAndPushCluster(defaultGit, clusterDir, message);
}

function resolveBy(argv) {
  const idx = argv.indexOf("--by");
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  try {
    const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
    if (email) return email;
  } catch {
    /* fall through */
  }
  return process.env.USER || "unknown";
}

function renderShow(json) {
  const lines = [`routes: ${formatRoutesForMessage(json.routes)}`];
  lines.push(`updatedBy: ${json.updatedBy ?? "(none)"}`);
  lines.push(`updatedAt: ${json.updatedAt ?? "(none)"}`);
  return lines.join("\n") + "\n";
}

function renderHistory(json) {
  if (!json.history || json.history.length === 0) return "(no history)\n";
  return (
    json.history
      .map((e) => `${e.at ?? "?"}  ${e.by ?? "?"}  ${e.change?.phase} -> ${e.change?.to ?? "unrouted"} (was: ${e.change?.from ?? "unrouted"})`)
      .join("\n") + "\n"
  );
}

// resolveFloorPercent — CTL-2116 Phase 5. Precedence ladder (mirrors the
// deployment-mode precedent): CATALYST_CODEX_BUDGET_FLOOR_PERCENT env >
// cluster.json.executorPolicy.codexBudgetFloorPercent > the frozen default.
function resolveFloorPercent(policy) {
  const envVal = process.env.CATALYST_CODEX_BUDGET_FLOOR_PERCENT;
  if (typeof envVal === "string" && envVal.trim() !== "") {
    const n = Number(envVal);
    if (Number.isFinite(n)) return n;
  }
  if (typeof policy?.codexBudgetFloorPercent === "number") {
    return policy.codexBudgetFloorPercent;
  }
  return DEFAULT_CODEX_BUDGET_FLOOR_PERCENT;
}

// defaultReadAccounts — the SAME pair codex-accounts-usage.mjs uses
// (discoverCodexHomes + readAccountPlane), folded to the {label,status,binding}
// shape classifyPolicyBudget expects. Reads every home SEQUENTIALLY (one
// short-lived `codex app-server` child at a time — zero token cost, ~1-2s each),
// matching that tool's own rationale: no need to race a handful of short reads.
async function defaultReadAccounts() {
  const root = process.env.CATALYST_CODEX_ROOT
    ? resolve(process.env.CATALYST_CODEX_ROOT)
    : undefined;
  const discovery = discoverCodexHomes(root);
  const bin = process.env.CATALYST_CODEX_BIN || "codex";
  const out = [];
  for (const acct of discovery.accounts) {
    const verdict = await readAccountPlane({ codexHome: acct.path, bin });
    out.push({ label: acct.handle, status: verdict.status, binding: verdict.binding });
  }
  return out;
}

export async function runRoute(argv = []) {
  const asJson = argv.includes("--json");
  const clusterDir = getClusterRepoDir();
  const deps = {
    clusterDir,
    isDirty: defaultIsDirty,
    pull: defaultPull,
    readPolicy: (dir) => readExecutorPolicy(dir),
    writePolicy: defaultWritePolicy,
    commitAndPush: defaultCommitAndPush,
    // CTL-2116 Phase 5: real budget check — only ever invoked by routeCommand
    // for a codex-ADDING change (guard 5), so a codex-removing/no-op command
    // never spawns a single codex app-server child. classifyPolicyBudget
    // itself stays synchronous (its own contract — see
    // executor-policy-budget.mjs); the async account read happens HERE, and
    // the resolved list is handed in as `accounts`, not as a `readAccounts`
    // thunk (which the classifier would call synchronously).
    checkBudget: async () => {
      let accounts;
      try {
        accounts = await defaultReadAccounts();
      } catch {
        // A throwing reader is exactly what `accounts: []` already classifies
        // as inconclusive below — fail toward "could not look", never "allow".
        accounts = [];
      }
      return classifyPolicyBudget({
        addsCodexLoad: true,
        floorPercent: resolveFloorPercent(readExecutorPolicy(clusterDir)),
        accounts,
      });
    },
    by: resolveBy(argv),
    host: getHostName(),
    at: new Date().toISOString(),
    emitEvent: defaultAppendOperatorEvent,
  };
  const r = await routeCommand(argv, deps);
  if (asJson && r.json) {
    process.stdout.write(JSON.stringify(r.json) + "\n");
  } else if (r.json && argv[0] === "show") {
    process.stdout.write(renderShow(r.json));
  } else if (r.json && argv[0] === "history") {
    process.stdout.write(renderHistory(r.json));
  } else if (r.msg) {
    (r.code === 0 ? process.stdout : process.stderr).write(r.msg + "\n");
  }
  return r.code ?? 0;
}
