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
// CTL-1157: the open-PR ENUMERATOR lives in its own module (open-pr-gate.mjs). It
// is a FACTS source, NOT a refuse-gate (see THE REVERSAL there). The agent `declare`
// path does NOT consult it — the senior-engineer delegate already enumerated and
// reasoned about the ticket's open PRs (finishing/merging the needed ones, closing
// the abandoned ones) BEFORE calling declare. The reconciler drain (cmdReconcile)
// consults it only to fire the LOUD `recovery.done-applied-with-open-pr` alarm when
// a pure-code Done write lands while an open PR still exists. Re-exported for
// back-compat (tests import defaultCheckOpenPrs from the CLI).
import { defaultCheckOpenPrs, defaultDeriveBranchName } from "./open-pr-gate.mjs";
import {
  appendRecoveryDoneOpenPrEvent,
  appendRecoveryDoneAppliedEvent,
} from "./recovery-done-open-pr-event.mjs";
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
      case "--transition-verified":
        a.transitionVerified = true;
        break; // CTL-1157 F #3: the caller confirmed the REAL Linear Done transition
        // succeeded (rc=0). Gates the pipeline-record-only ENFORCE recovery.done-applied:
        // without it we would report an applied Done even when linear-transition.sh
        // failed or was missing. Absent → treat as pending/shadow (the drain lands it).
      case "--states-file":
        a.statesFile = next();
        break; // offline/test read seam
      case "--no-emit":
        a.noEmit = true;
        break; // offline/test
      // CTL-1157 SLICE 3: the delegate's PR-2 remediation counts, threaded into the
      // recovery.done-applied "Done-moves" event. The agent enumerated + reasoned
      // about every open PR before declaring; these record WHAT it did (closed N,
      // kept N) and how many were STILL open at the Done (open-at-done>0 = red-line).
      // Default 0 (a non-agent declare emits a clean 0/0/0 move).
      case "--prs-closed":
        a.prsClosed = Number(next());
        break;
      case "--prs-kept":
        a.prsKept = Number(next());
        break;
      case "--open-prs-at-done":
        a.openPrsAtDone = Number(next());
        break;
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
  --prs-closed <n>  declare: # of the ticket's PRs the agent CLOSED during PR-2
                    remediation — recorded on the recovery.done-applied event
  --prs-kept <n>    declare: # of PRs the agent finished/merged as part-of-solution
  --open-prs-at-done <n>
                    declare: # of PRs STILL open at the Done (>0 = the red-line the
                    Done-moves panel alarms on; a clean delegate Done is 0)
  --config <path>   .catalyst/config.json supplying stateMap + repoRoot
                    (default: <cwd>/.catalyst/config.json)
  --write           reconcile: actually write (default dry-run)
  --no-write        declare: persist + emit only, don't write Linear now
  --require-prs-merged
                    no-op (retained for back-compat). CTL-1157 REVERSED the old
                    fail-closed gate: declare no longer refuses a Done write when an
                    open PR exists — the senior-engineer delegate enumerates and
                    resolves the ticket's open PRs itself BEFORE declaring. The
                    reconcile drain (pure code) instead emits the loud
                    recovery.done-applied-with-open-pr event when it lands a Done
                    while a PR is still open.
  --branch <name>   no-op (retained for back-compat): the open-PR ENUMERATOR derives
                    the branchName from the local replica/cache itself.
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

  // CTL-1157 (THE REVERSAL): the agent `declare` path is NOT gated. The
  // Done-safety mechanism is AGENT JUDGMENT, not a mechanical fail-closed block.
  // By the time the senior-engineer recovery-pass delegate calls `declare --state
  // done` it has ALREADY enumerated this ticket's open PRs (open-pr-gate.mjs) and
  // reasoned about each — finishing/merging the ones that are part of the solution,
  // CLOSING the abandoned/superseded ones itself — then decided, autonomously, to
  // mark Done. Handcuffing that decision with a refuse-gate (the prior behavior,
  // now removed) would override a senior engineer's judgment and force needless
  // human escalation. The hard block is held IN RESERVE; the `reconcile` drain
  // backstop (cmdReconcile) carries the observability alarm that would justify
  // adding it. `--require-prs-merged` / `--branch` are retained as no-op back-compat.
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

  // CTL-1157 SLICE 3 (Done-moves panel) + GROUP 1 (observable teardown Done): emit
  // the broad recovery.done-applied so OTEL charts every autonomous Done. Three shapes:
  //
  //  (a) PIPELINE RECORD-ONLY marker (`--no-write --by pipeline`): phase-teardown has
  //      ALREADY performed the REAL Linear Done (via linear-transition.sh, no
  //      telemetry) and is now dropping a durable record. This is the RECORD OF A REAL
  //      EXTERNAL DONE — NOT a shadow. Emit recovery.done-applied in ENFORCE mode (a
  //      real applied Done, NOT a would-event — re-introducing a shadow here was Codex
  //      round-1 #7) AND run the open-PR enumeration → fire the loud
  //      recovery.done-applied-with-open-pr alarm if ≥1 open PR (or unverifiable). This
  //      is the ONLY observability for a normal-pipeline teardown Done: the real Done
  //      emits nothing, the later terminal-sweep sees already-Done → action:"skipped"
  //      → emits nothing, so WITHOUT this a teardown Done with an open PR is SILENT.
  //      No agent supplied PR tallies here (this is pure-pipeline, not the delegate),
  //      so prs_closed/prs_kept are 0 and open_prs_at_done carries the enumerated count
  //      — observable + alarmed exactly like the two pure-code backstops (drain +
  //      terminal sweep).
  //  (b) GENUINE SHADOW (any other actor's true --no-write declaration): the delegate
  //      does not write Done → emit the recovery.would-done-applied SHADOW variant
  //      (telemetry only, no write, no enumeration/alarm). The agent supplies its own
  //      PR-2 remediation tallies (prs_closed / prs_kept / open_prs_at_done) via flags.
  //  (c) REAL APPLIED DONE on this path (not --no-write): emit recovery.done-applied
  //      (enforce) with the agent-supplied tallies. An idempotent already-Done noop is
  //      not a "move" and emits nothing.
  if (!args.noEmit && String(args.state).toLowerCase() === "done") {
    const emitDoneApplied = deps.emitDoneApplied || appendRecoveryDoneAppliedEvent;
    const realDone = wrote && wrote.kind === "done" && wrote.applied && wrote.writeAction !== "skipped";
    const pipelineRecordOnly =
      args.noWrite && String(args.by).toLowerCase() === "pipeline";
    // CTL-1157 F #3: only the pipeline marker whose REAL Done transition was VERIFIED
    // (rc=0, via --transition-verified) is a record of a Done that actually landed →
    // ENFORCE done-applied + open-PR alarm. A marker dropped after a FAILED or MISSING
    // linear-transition.sh (SKILL.md still runs `declare` on that path) is NOT proof of
    // a Done: it falls through to the shadow would-event below (recoveryMode:"shadow"),
    // so OTEL never charts an applied Done that did not happen; the reconcile drain /
    // terminalDoneOnce backstop lands the real Done and re-declares it later.
    if (pipelineRecordOnly && args.transitionVerified) {
      // (a) record of a REAL external Done — enumerate open PRs so the teardown Done is
      // observable + alarmed. Best-effort; observability must never break declare.
      const checkOpenPrs = deps.checkOpenPrs || defaultCheckOpenPrs;
      const emitDoneWithOpenPr = deps.emitDoneWithOpenPr || appendRecoveryDoneOpenPrEvent;
      const { configPath } = resolveConfig(args);
      const repoRoot = existsSync(configPath) ? dirname(dirname(configPath)) : null;
      let openPrs = [];
      let unverifiable = false;
      try {
        const facts = checkOpenPrs(ticket, repoRoot ? { cwd: repoRoot } : {});
        if (facts && facts.unverifiable) unverifiable = true;
        if (facts && Array.isArray(facts.prs)) openPrs = facts.prs;
      } catch {
        unverifiable = true; // could not confirm clean ⇒ surface (don't assume zero)
      }
      try {
        emitDoneApplied({
          ticket,
          openPrsAtDone: openPrs.length,
          prsClosed: 0,
          prsKept: 0,
          // The real Done ALREADY landed via linear-transition.sh — this is a genuine
          // applied Done, so enforce (NOT shadow). Codex round-1 #7: no would-event here.
          recoveryMode: "enforce",
          by: args.by,
        });
      } catch {
        /* observability must never break declare */
      }
      // ALARM-NOT-BLOCK: a Done that landed while ≥1 open PR remains — OR whose open-PR
      // check was UNVERIFIABLE (a Done that landed without confirming the board was
      // clean) — fires the loud alarm. A clean, CONFIRMED teardown Done stays silent.
      if (openPrs.length >= 1 || unverifiable) {
        try {
          emitDoneWithOpenPr({ ticket, openPrs, by: "pipeline-teardown", unverifiable });
        } catch {
          /* observability must never break declare */
        }
      }
    } else if (args.noWrite || realDone) {
      // (b) genuine shadow would-apply, or (c) a real applied Done on this path.
      try {
        emitDoneApplied({
          ticket,
          openPrsAtDone: Number.isFinite(args.openPrsAtDone) ? args.openPrsAtDone : 0,
          prsClosed: Number.isFinite(args.prsClosed) ? args.prsClosed : 0,
          prsKept: Number.isFinite(args.prsKept) ? args.prsKept : 0,
          // --no-write = no actual Done write yet (the drain lands it) → shadow/would.
          recoveryMode: args.noWrite ? "shadow" : "enforce",
          by: args.by,
        });
      } catch {
        /* observability must never break declare */
      }
    }
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

async function cmdReconcile(args, deps = {}) {
  const { configPath, stateMap, terminalStates } = resolveConfig(args);
  const dir = args.declsDir || completionsDir();
  const pending = listDeclarations({ dir, pendingOnly: true });
  const readState = await buildReadState(args);

  let applyCorrection;
  if (args.write) {
    // Test seam: deps.applyCorrection lets a test simulate the Linear write without
    // shelling to linearis. Production passes none → the real linear-write primitive.
    if (deps.applyCorrection) {
      applyCorrection = deps.applyCorrection;
    } else {
      const { applyTerminalDone, applyPhaseStatus } = await import("./linear-write.mjs");
      applyCorrection = buildApplyCorrection(configPath, { applyTerminalDone, applyPhaseStatus });
    }
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

  // CTL-1157 (ALARM-NOT-BLOCK): the `reconcile` drain is a PURE-CODE backstop — no
  // agent reasons here. Per THE REVERSAL it PROCEEDS (never wedges the board, never
  // escalates), but when it just LANDED a real Done transition for a ticket that
  // still has ≥1 OPEN PR, it emits the loud `recovery.done-applied-with-open-pr`
  // event so we get the signal that would justify adding a hard block later. A clean
  // Done (0 open PRs) emits nothing. Best-effort: enumeration/emit failure NEVER
  // affects the drain's outcome. Only runs on a real write (`--write`).
  if (args.write) {
    const checkOpenPrs = deps.checkOpenPrs || defaultCheckOpenPrs;
    const emit = deps.emitDoneWithOpenPr || appendRecoveryDoneOpenPrEvent;
    const emitDoneApplied = deps.emitDoneApplied || appendRecoveryDoneAppliedEvent;
    // CTL-1157 fix #2 (+ Codex round-8): run the gh enumeration in EACH ticket's OWN
    // repository. The drain processes pending declarations from the GLOBAL completions
    // store, so its rows can belong to DIFFERENT project repos than this CLI's --config.
    // Forcing the CLI's config repoRoot as cwd for every ticket would query gh in the
    // wrong repo for cross-project rows (a false-clean or false-open result). Pass NO
    // cwd → defaultCheckOpenPrs derives the repo PER TICKET from the registry
    // (deriveRepoRoot(ticket)); an underivable ticket surfaces as unverifiable, never a
    // silent clean. NEVER bare linearis, never the process cwd.
    for (const r of rows) {
      // A real Done transition that actually changed state (not an idempotent
      // already-Done noop, not a dry-run, not a failed/skip row).
      if (r.kind !== "done" || !r.applied || r.writeAction === "skipped") continue;
      let openPrs = [];
      let unverifiable = false;
      try {
        const facts = checkOpenPrs(r.ticket, {});
        if (facts && facts.unverifiable) unverifiable = true;
        if (facts && Array.isArray(facts.prs)) openPrs = facts.prs;
      } catch {
        unverifiable = true; // could not confirm clean ⇒ surface (don't assume zero)
      }
      // CTL-1157 SLICE 3 (Done-moves panel): emit the broad recovery.done-applied on
      // EVERY drained Done (not just the open-PR subset). The drain is a pure-code
      // backstop with no agent to reason about PRs → prs_closed/prs_kept are 0;
      // open_prs_at_done carries the enumerated count (the red-line). Best-effort.
      try {
        emitDoneApplied({
          ticket: r.ticket,
          openPrsAtDone: openPrs.length,
          prsClosed: 0,
          prsKept: 0,
          recoveryMode: "enforce", // the drain only ever does real writes
          by: "reconcile-drain",
        });
      } catch {
        /* observability must never break the drain */
      }
      // CTL-1157 (ALARM-NOT-BLOCK): alarm when ≥1 open PR remains OR the open-PR
      // check was UNVERIFIABLE — a Done that landed without confirming the board was
      // clean is the silent-Done risk this alarm surfaces. A clean, CONFIRMED Done is
      // silent.
      if (openPrs.length >= 1 || unverifiable) {
        try {
          emit({ ticket: r.ticket, openPrs, by: "reconcile-drain", unverifiable });
        } catch {
          /* observability must never break the drain */
        }
      }
    }
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
  if (cmd === "reconcile") return cmdReconcile(args, deps);
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
