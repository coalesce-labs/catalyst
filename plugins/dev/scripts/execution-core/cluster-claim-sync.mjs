#!/usr/bin/env node
// cluster-claim-sync.mjs — a SYNCHRONOUS bridge over the async cluster-claim CLI
// (CTL-850, the behavioral-cutover PR).
//
// Why this exists: the execution-core dispatch paths (scheduler.mjs schedulerTick,
// monitor.mjs dispatchTriage) are synchronous, and their existing daemon-side
// Linear writes already go through synchronous spawnSync shell wrappers
// (linear-write.mjs → linear-transition.sh). The cross-host claim, by contrast,
// is async (fetch-based, in cluster-claim.mjs). Rather than make the whole tick
// async (which would churn the 292KB scheduler/monitor test suites and the
// setInterval/setTimeout drivers), we drive the claim through spawnSync of
// `node cluster-claim.mjs claim …` here — the same sync-subprocess convention the
// daemon already uses for Linear writes, and it reuses the verified, tested lib.
//
// FAIL-CLOSED contract: ANY failure — spawn error, timeout, non-zero exit, or
// unparseable stdout — is reported as { won: false }. The caller then does NOT
// dispatch this tick and reconsiders next tick. A transient Linear hiccup must
// never cause a double-dispatch; deferring is always safe (the HRW pre-filter
// already guarantees only the owning host even reaches the claim).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// CLUSTER_CLAIM_CLI — absolute path to the claim CLI, resolved relative to this
// module so it works regardless of the daemon's cwd.
const CLUSTER_CLAIM_CLI = fileURLToPath(new URL("./cluster-claim.mjs", import.meta.url));

// CLAIM_TIMEOUT_MS — hard cap on the claim subprocess. The soft-CAS is up to four
// sequential Linear round-trips (read → resolve → write → read-back); 15s is
// generous for a healthy API and bounds a hung call so a stuck claim can't wedge
// a tick. Overridable for tests / slow networks.
const CLAIM_TIMEOUT_MS = Number(process.env.EXECUTION_CORE_CLAIM_TIMEOUT_MS) || 15_000;

// claimDispatchSync — soft-CAS claim `ticket` for `hostName` at `phase`,
// synchronously. Returns { won, generation }. won:false on any failure
// (fail-closed). `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable so the
// unit tests never spawn a real process.
export function claimDispatchSync(
  { ticket, hostName, phase },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_CLAIM_CLI,
    env = process.env,
    timeout = CLAIM_TIMEOUT_MS,
  } = {},
) {
  try {
    const res = spawn(nodeBin, [cli, "claim", ticket, hostName, phase], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      return { won: false, generation: null };
    }
    // The CLI prints exactly one JSON line; take the last non-empty line defensively.
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    const parsed = JSON.parse(line);
    return {
      won: parsed?.won === true,
      generation: Number.isFinite(parsed?.generation) ? parsed.generation : null,
    };
  } catch {
    return { won: false, generation: null };
  }
}
