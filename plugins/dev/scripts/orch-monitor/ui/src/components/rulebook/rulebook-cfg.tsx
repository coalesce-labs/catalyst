// rulebook-cfg.tsx — CTL-1328: shared cfg-threshold helpers. The tunable
// thresholds (never_started_ms, max_attempts, …) the rules read. Values come
// live from /api/beliefs/cfg; the one-line descriptions are authored here. Used
// by the Thresholds appendix (full table) and the per-belief Thresholds section.
import { useEffect, useState } from "react";
import { StateChip } from "@/components/ui/state-chip";

export interface CfgRow {
  key: string;
  value_int: number | null;
  value_text: string | null;
}

// cfg keys whose value is a Linear workflow state, rendered as a chip.
const STATE_VALUED_KEYS = new Set([
  "eligible_state",
  "triageStatus",
  "triage_status",
]);

// One-line "what is this for" per cfg key (the consuming rule noted in parens).
const CFG_DESCRIPTIONS: Record<string, string> = {
  never_started_ms:
    "How long a registered session may sit without starting a turn before it counts as a never-started wedge (R4).",
  lease_window_doc_ms:
    "Freshness window for doc-type phases (triage, research, plan, pr, monitor-*): progress newer than this keeps the lease valid (R5).",
  lease_window_build_ms:
    "Freshness window for build-type phases (implement, verify, review): progress newer than this keeps the lease valid (R5).",
  diag_cooldown_ms:
    "Minimum gap between diagnostician wake-ups for the same subject, so it isn't re-woken every tick (R10).",
  max_attempts:
    "How many times an intent may be attempted with no outcome before it is deemed ineffective (R11).",
  max_parallel: "Maximum concurrent in-flight phases (valid leases) per host (R8).",
  session_cap: "Maximum concurrent background agent sessions per host (R8).",
  eligible_state:
    "The Linear workflow state a ticket must be in for the daemon to pick it up as new work (R15).",
  rules_sha_last_seen:
    "Internal: the rules.dl content hash the engine last compiled against — bookkeeping, not a tunable.",
};

export function cfgDescription(key: string): string | null {
  if (key in CFG_DESCRIPTIONS) return CFG_DESCRIPTIONS[key];
  if (key.startsWith("hb_cursor")) {
    return "Internal: byte offset into the event log the heartbeat reader has consumed — bookkeeping, not a tunable.";
  }
  return null;
}

/** Render a cfg value: a workflow-state value as a chip, numbers grouped at the
 *  thousands (1,800,000 not 1800000), else the raw text. */
export function CfgValue({ row }: { row: CfgRow }) {
  if (STATE_VALUED_KEYS.has(row.key) && row.value_text) {
    return <StateChip state={row.value_text} />;
  }
  if (row.value_int != null) {
    return (
      <span className="font-mono text-xs">
        {row.value_int.toLocaleString("en-US")}
      </span>
    );
  }
  return <span className="font-mono text-xs">{row.value_text ?? "—"}</span>;
}

export interface BeliefCfgState {
  rows: CfgRow[] | null; // null while loading
  byKey: Map<string, CfgRow>;
  unavailable: boolean;
}

// Module-level cache so the appendix + every detail render share ONE fetch.
let _cache: BeliefCfgState | null = null;
let _inflight: Promise<BeliefCfgState> | null = null;

/** The live cfg thresholds (GET /api/beliefs/cfg), keyed for lookup. Cached
 *  across components; degrades to `unavailable` on any fetch error. */
export function useBeliefCfg(): BeliefCfgState {
  const [state, setState] = useState<BeliefCfgState>(
    _cache ?? { rows: null, byKey: new Map(), unavailable: false },
  );

  useEffect(() => {
    if (_cache) {
      setState(_cache);
      return;
    }
    if (!_inflight) {
      _inflight = fetch("/api/beliefs/cfg")
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<{ rows?: CfgRow[] }>;
        })
        .then((d) => {
          const rows = d.rows ?? [];
          _cache = {
            rows,
            byKey: new Map(rows.map((x) => [x.key, x])),
            unavailable: false,
          };
          return _cache;
        })
        .catch(() => {
          _cache = { rows: [], byKey: new Map(), unavailable: true };
          return _cache;
        });
    }
    let stop = false;
    void _inflight.then((s) => {
      if (!stop) setState(s);
    });
    return () => {
      stop = true;
    };
  }, []);

  return state;
}
