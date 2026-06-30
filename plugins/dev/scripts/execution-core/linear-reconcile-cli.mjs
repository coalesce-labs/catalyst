// linear-reconcile-cli.mjs — CTL-1371 operator/model entry point for the
// completion-signal-driven Linear reconciler (run via `catalyst-linear-reconcile`).
//
// Linear state is driven by EXPLICIT completion declarations, never inferred from
// PR/merge state. Commands:
//   declare <TICKET> [--state done] …   drop the lightweight "this is done" signal
//                                       (persist + emit + best-effort write now)
//   reconcile [--write] …               drain PENDING declarations → Linear (retry)
//   status                              list pending declarations
//
// SAFE BY DEFAULT: `reconcile` is dry-run unless --write. `declare` writes Linear
// immediately (that IS the intent of declaring done) unless --no-write, and always
// persists a durable marker so a failed write is retried by the drain.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { reconcileDeclarations, orderedStatesForMap } from "./linear-reconcile.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import {
  declare as storeDeclare,
  listDeclarations,
  markReconciled,
  completionsDir,
} from "./linear-reconcile-store.mjs";
// CTL-1157: the open-PR Done gate lives in its own module so the execution-core
// terminal sweep (scheduler.mjs terminalDoneOnce) runs the IDENTICAL check. Kept
// re-exported here for back-compat (tests import defaultCheckOpenPrs from the CLI).
import { defaultCheckOpenPrs, defaultDeriveBranchName } from "./open-pr-gate.mjs";
export { defaultCheckOpenPrs, defaultDeriveBranchName };

const TICKET_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export function parseArgs(argv) {
  const a = {
    _: [],
    state: "done",
    by: "model",
    write: false,
    noWrite: false,
    json: false,
    graphql: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    switch (v) {
      case "--state":
        a.state = next();
        break;
      case "--note":
        a.note = next();
        break;
      case "--by":
        a.by = next();
        break;
      case "--config":
        a.config = next();
        break;
      case "--write":
        a.write = true;
        break;
      case "--no-write":
        a.noWrite = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--graphql":
        a.graphql = true;
        break;
      case "--decls-dir":
        a.declsDir = next();
        break;
      case "--branch":
        a.branch = next();
        break; // optional: known Linear branchName for the open-PR head pass
      case "--require-prs-merged":
        a.requirePrsMerged = true;
        break; // no-op opt-in: the open-PR gate is now UNIVERSAL for `--state done` (CTL-1157)
      case "--states-file":
        a.statesFile = next();
        break; // offline/test read seam
      case "--no-emit":
        a.noEmit = true;
        break; // offline/test
      case "-h":
      case "--help":
        a.help = true;
        break;
      default:
        if (v?.startsWith("--")) a.error = `unknown option: ${v}`;
        else a._.push(v);
    }
  }
  return a;
}

const HELP = `catalyst-linear-reconcile — drive Linear ticket state from EXPLICIT completion
declarations (CTL-1371). Linear is NEVER moved by inferring from PR/merge state;
the agent/model/human declares "done" and this keeps Linear in sync, reliably.

Usage:
  catalyst-linear-reconcile declare <TICKET> [options]
      Drop the lightweight completion signal: persist a durable declaration, emit
      a ticket.completion.declared event, and (unless --no-write) write Linear now
      via the canonical primitive. The reconcile drain retries any write that
      didn't land. --state <key> defaults to 'done' (a stateMap key).

  catalyst-linear-reconcile reconcile [options]
      Drain PENDING declarations → Linear (dry-run unless --write); retries writes
      that previously failed (rate-limit / daemon down / breaker).

  catalyst-linear-reconcile status [--json]
      List pending declarations.

Options:
  --state <key>     target stateMap key for declare (default 'done')
  --note <text>     freeform note stored with the declaration
  --by <who>        who declared it (default 'model')
  --config <path>   .catalyst/config.json supplying stateMap + repoRoot
                    (default: <cwd>/.catalyst/config.json)
  --write           reconcile: actually write (default dry-run)
  --no-write        declare: persist + emit only, don't write Linear now
  --require-prs-merged
                    no-op (retained for back-compat): the open-PR gate is now
                    UNIVERSAL — EVERY '--state done' declare (any --by: recovery-pass,
                    pipeline/teardown, model, human) refuses the Done write
                    (fail-closed, exit 2) if ANY unmerged PR for the ticket is still
                    open. Merge/close the open PR first. (CTL-1157)
  --branch <name>   declare: known Linear branchName for the open-PR head pass.
                    Optional — when omitted the gate derives it from the local
                    replica/cache (catalyst-linear source:replica, never linearis).
  --graphql         read current state via Linear GraphQL ($LINEAR_API_TOKEN)
                    for tickets absent from the local cache (unenrolled repos)
  --json            machine-readable output
  -h, --help        show this help`;

// ── shared I/O seams ──────────────────────────────────────────────────────────

function loadConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

async function graphqlReadState(ticket, token) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(ticket);
  if (!m) return null;
  if (!token) throw new Error("LINEAR_API_TOKEN not set (required for --graphql)");
  const [, key, number] = m;
  const query = `query($n: Float!){ issues(filter:{ team:{ key:{ eq:"${key}" } }, number:{ eq:$n } }){ nodes{ state{ name } } } }`;
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables: { n: Number(number) } }),
  });
  if (!r.ok) throw new Error(`Linear API ${r.status} for ${ticket}`);
  const j = await r.json();
  if (j?.errors?.length)
    throw new Error(`Linear GraphQL error for ${ticket}: ${j.errors[0]?.message ?? "unknown"}`);
  return j?.data?.issues?.nodes?.[0]?.state?.name ?? null;
}

async function buildReadState(args) {
  if (args.statesFile) {
    const map = JSON.parse(readFileSync(args.statesFile, "utf8"));
    return async (t) => map[t] ?? null;
  }
  if (args.graphql) {
    const token = process.env.LINEAR_API_TOKEN;
    return async (t) => graphqlReadState(t, token);
  }
  // cache (filter-state.db). broker-state.mjs imports bun:sqlite → under plain
  // node the import throws; degrade to unknown (null) with a one-time warning.
  let getDescriptor = null;
  try {
    const mod = await import("../broker/broker-state.mjs");
    let opened = false;
    getDescriptor = (t) => {
      if (!opened) {
        mod.openBrokerStateDb();
        opened = true;
      }
      return mod.getTicketDescriptor(t)?.state ?? null;
    };
  } catch {
    process.stderr.write(
      "warn: local cache unavailable under this runtime (need bun, or pass --graphql/--states-file); current state reads as unknown\n"
    );
  }
  return async (t) => {
    try {
      return getDescriptor ? getDescriptor(t) : null;
    } catch {
      return null;
    }
  };
}

function buildApplyCorrection(configPath, primitives) {
  const { applyTerminalDone, applyPhaseStatus } = primitives;
  const repoRoot = existsSync(configPath) ? dirname(dirname(configPath)) : null;
  const resolveRepoRoot = repoRoot ? () => repoRoot : undefined;
  return ({ ticket, kind }) =>
    kind === "done"
      ? applyTerminalDone({ ticket, resolveRepoRoot })
      : applyPhaseStatus({ ticket, phase: kind === "inReview" ? "pr" : kind, resolveRepoRoot });
}

function emitDeclared(decl, enabled) {
  if (!enabled) return;
  try {
    const dir = process.env.CATALYST_DIR || join(homedir(), "catalyst");
    const d = new Date();
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const file = join(dir, "events", `${month}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    const name = `ticket.completion.declared.${decl.ticket}`;
    // Canonical OTel envelope so the name lands in attributes["event.name"] where
    // catalyst-events filters + scanners read it (Codex P2).
    const payload = { ticket: decl.ticket, state: decl.state, by: decl.declaredBy };
    const env = {
      ts: d.toISOString(),
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: { "event.name": name, ...payload },
      body: { payload },
    };
    appendFileSync(file, JSON.stringify(env) + "\n");
  } catch {
    /* best-effort observability */
  }
}

function resolveConfig(args) {
  const configPath = args.config || `${process.cwd()}/.catalyst/config.json`;
  const cfg = loadConfig(configPath);
  const stateMap = cfg?.catalyst?.linear?.stateMap ?? {};
  const teamKeys = cfg?.catalyst?.linear?.teamKey ? [cfg.catalyst.linear.teamKey] : [];
  const terminalStates = [
    ...new Set([stateMap.done, stateMap.canceled, "Done", "Canceled", "Duplicate"].filter(Boolean)),
  ];
  return { configPath, stateMap, teamKeys, terminalStates };
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdDeclare(args, deps = {}) {
  const ticket = args._[1];
  if (!ticket || !TICKET_RE.test(ticket)) {
    process.stderr.write("error: declare needs a ticket id (e.g. CTL-123)\n");
    return 2;
  }

  // CTL-1157 (UNIVERSAL gate): MANDATORY, non-bypassable open-PR gate for EVERY
  // declaration that targets terminal Done — regardless of `--by`. The owner's #1
  // rule is "NEVER mark a ticket Done while it still has an open/unmerged PR", so
  // the gate is keyed on the TARGET STATE (`done`), not the declarer identity: the
  // autonomous recovery-pass delegate, the teardown/pipeline completion-signal path
  // (`--by pipeline`), the default `--by model`, and a human all run it. A wrong
  // Done write clears the needs-human label and stops all scheduler attention, and
  // is hard to undo — exactly the false-positive that got the GitHub-PR→Done
  // automation removed (one merged PR + one still-open PR on a NON-standard branch →
  // falsely Done). This is the deterministic CODE backstop, NOT a prompt step the
  // LLM could forget. Runs BEFORE storeDeclare so a refusal persists NO durable
  // marker — otherwise a later `reconcile --write` drain could land the Done write
  // unchecked (THAT is what makes the drain safe by construction). It is FAIL-CLOSED:
  // an unverifiable PR set (gh missing/auth/network) refuses the write. A non-`done`
  // target (e.g. `--state canceled` / a phase state) is NOT gated — only completion.
  // `--require-prs-merged` is retained as a no-op opt-in for callers/tests.
  const openPrGateRequired = args.state === "done";
  if (openPrGateRequired) {
    const checkOpenPrs = deps.checkOpenPrs || defaultCheckOpenPrs;
    // branchName is ALWAYS resolved (CTL-1157): use --branch when passed, else the
    // gate derives it from the local replica/cache (catalyst-linear source:replica,
    // NEVER bare linearis) so a non-standard-branch PR is still caught.
    const gate = checkOpenPrs(ticket, { branchName: args.branch });
    if (!gate || !gate.ok) {
      const detail = gate?.reason
        ? `open-PR set could not be verified (${gate.reason})`
        : `${gate?.prs?.length ?? 0} unmerged PR(s) still open (${(gate?.prs ?? [])
            .map((p) => `#${p.number}`)
            .join(", ")})`;
      process.stderr.write(
        `error: ${ticket} refusing Done declaration — ${detail}; merge/close the open PR(s) first\n`
      );
      // Fail-closed: nothing persisted, nothing written. The delegate gates on this
      // non-zero exit and escalates (Rubric Three) instead of advertising Done.
      return 2;
    }
  }

  const dir = args.declsDir || completionsDir();
  const decl = storeDeclare(
    { ticket, state: args.state, declaredBy: args.by, note: args.note },
    { dir }
  );
  emitDeclared(decl, !args.noEmit);

  let wrote = null;
  if (!args.noWrite) {
    const { configPath, stateMap, terminalStates } = resolveConfig(args);
    const readState = await buildReadState(args);
    const { applyTerminalDone, applyPhaseStatus } = await import("./linear-write.mjs");
    const applyCorrection = buildApplyCorrection(configPath, {
      applyTerminalDone,
      applyPhaseStatus,
    });
    const { rows } = await reconcileDeclarations({
      declarations: [decl],
      stateMap,
      terminalStates,
      readState,
      applyCorrection,
      dryRun: false,
    });
    wrote = rows[0];
    const satisfied =
      wrote && (wrote.decision === "in-sync" || (wrote.decision === "correct" && wrote.applied));
    if (satisfied)
      markReconciled(ticket, wrote.to_state ?? wrote.target ?? wrote.currentState, { dir });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ declared: decl, write: wrote }, null, 2) + "\n");
  } else {
    const tag = args.noWrite
      ? "declared (no write)"
      : wrote?.applied
        ? `declared + written → ${wrote.to_state ?? wrote.target}`
        : `declared; write pending (${wrote?.reason ?? wrote?.writeReason ?? "not-applied"}) — the drain will retry`;
    process.stdout.write(`${ticket} ${args.state}: ${tag}\n`);
  }
  // Exit 0 on declare: the durable signal is dropped regardless of the immediate write.
  return 0;
}

async function cmdReconcile(args) {
  const { configPath, stateMap, terminalStates } = resolveConfig(args);
  const dir = args.declsDir || completionsDir();
  const pending = listDeclarations({ dir, pendingOnly: true });
  const readState = await buildReadState(args);

  let applyCorrection;
  if (args.write) {
    const { applyTerminalDone, applyPhaseStatus } = await import("./linear-write.mjs");
    applyCorrection = buildApplyCorrection(configPath, { applyTerminalDone, applyPhaseStatus });
  }

  const { rows, summary } = await reconcileDeclarations({
    declarations: pending,
    stateMap,
    terminalStates,
    orderedStates: orderedStatesForMap(stateMap),
    readState,
    applyCorrection,
    dryRun: !args.write,
  });
  // A declaration is reconciled once Linear reflects it (in-sync) or we just
  // wrote it (correct+applied) — clear it from the pending set in either case.
  for (const r of rows) {
    const satisfied = r.decision === "in-sync" || (r.decision === "correct" && r.applied);
    if (satisfied) markReconciled(r.ticket, r.to_state ?? r.target ?? r.currentState, { dir });
  }

  const mode = args.write ? "write" : "dry-run";
  if (args.json) {
    process.stdout.write(JSON.stringify({ mode, summary, rows }, null, 2) + "\n");
  } else {
    process.stdout.write(`reconcile (${pending.length} pending)   mode: ${mode}\n`);
    for (const r of rows) {
      const tag = r.error
        ? `ERROR ${r.error}`
        : r.decision === "correct"
          ? r.applied
            ? r.writeAction === "skipped"
              ? `noop (already ${r.to_state ?? r.target})`
              : `corrected → ${r.to_state ?? r.target}`
            : `${mode === "write" ? "FAILED" : "would correct"} → ${r.target}`
          : r.decision === "skip"
            ? `skip (${r.reason})`
            : r.decision;
      process.stdout.write(
        `  ${String(r.ticket).padEnd(12)} ${String(r.kind).padEnd(9)} current=${String(r.currentState ?? "?").padEnd(10)} ${tag}\n`
      );
    }
    process.stdout.write(
      `summary: ${summary.tickets} pending · ${summary.corrected} corrected · ${summary.noop} noop · ${summary.inSync} in-sync · ${summary.drift} drift · ${summary.skipped} skipped · ${summary.unconfirmed} unconfirmed · ${summary.failed} failed · ${summary.errors} errors\n`
    );
    if (args.write && summary.unconfirmed > 0) {
      process.stderr.write(
        `warn: ${summary.unconfirmed} declaration(s) had no readable current state and were NOT written (run with --graphql or against a populated cache)\n`
      );
    }
  }
  const unactioned = summary.errors + summary.failed + (args.write ? summary.unconfirmed : 0);
  return unactioned > 0 ? 1 : 0;
}

function cmdStatus(args) {
  const dir = args.declsDir || completionsDir();
  const pending = listDeclarations({ dir, pendingOnly: true });
  if (args.json) {
    process.stdout.write(JSON.stringify({ pending }, null, 2) + "\n");
  } else {
    process.stdout.write(`${pending.length} pending declaration(s):\n`);
    for (const d of pending) {
      process.stdout.write(
        `  ${String(d.ticket).padEnd(12)} ${String(d.state).padEnd(9)} by=${d.declaredBy ?? "?"} declaredAt=${d.declaredAt ?? "?"}\n`
      );
    }
  }
  return 0;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help || args._.length === 0) {
    process.stdout.write(HELP + "\n");
    return args.help ? 0 : 2;
  }
  if (args.error) {
    process.stderr.write(`error: ${args.error}\n\n${HELP}\n`);
    return 2;
  }
  const cmd = args._[0];
  if (cmd === "declare") return cmdDeclare(args, deps);
  if (cmd === "reconcile") return cmdReconcile(args);
  if (cmd === "status") return cmdStatus(args);
  // Back-compat alias: `--team`/`--repo`-style PR sweeps are GONE; guide the user.
  process.stderr.write(`error: unknown command '${cmd}'. Use declare | reconcile | status.\n`);
  return 2;
}

// Portable entrypoint guard (CTL-578): import.meta.main is undefined on Node <22.16.
const isEntrypoint =
  import.meta.main === true ||
  (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
if (isEntrypoint) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${err?.stack || err}\n`);
      process.exit(1);
    });
}
