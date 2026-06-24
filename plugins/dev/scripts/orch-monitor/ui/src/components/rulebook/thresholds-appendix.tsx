// thresholds-appendix.tsx — CTL-1103 / CTL-1320 / CTL-1328: the tunable cfg
// thresholds, in a closed-by-default Collapsible so the reading column stays calm.
// CTL-1328 (operator feedback): group big numbers at the thousands, render a
// state-valued key (eligible_state) as a state chip via the shared <StateChip/>,
// and give each key a one-line description of what it's for. Degrades quietly.
import { useEffect, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { StateChip } from "@/components/ui/state-chip";

interface CfgRow {
  key: string;
  value_int: number | null;
  value_text: string | null;
}

// cfg keys whose value is a Linear workflow state, rendered as a chip rather than
// raw text.
const STATE_VALUED_KEYS = new Set([
  "eligible_state",
  "triageStatus",
  "triage_status",
]);

// One-line "what is this for" per cfg key. The rule that consumes each key is
// noted in parens. Keys that are engine bookkeeping (not operator-tunable) say so.
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
  max_parallel:
    "Maximum concurrent in-flight phases (valid leases) per host (R8).",
  session_cap:
    "Maximum concurrent background agent sessions per host (R8).",
  eligible_state:
    "The Linear workflow state a ticket must be in for the daemon to pick it up as new work (R15).",
  rules_sha_last_seen:
    "Internal: the rules.dl content hash the engine last compiled against — bookkeeping, not a tunable.",
};

function cfgDescription(key: string): string | null {
  if (key in CFG_DESCRIPTIONS) return CFG_DESCRIPTIONS[key];
  // hb_cursor:<path> — one row per heartbeat source file.
  if (key.startsWith("hb_cursor")) {
    return "Internal: byte offset into the event log the heartbeat reader has consumed — bookkeeping, not a tunable.";
  }
  return null;
}

function CfgValue({ row }: { row: CfgRow }) {
  // A workflow-state value renders as a chip (the state, not a number).
  if (STATE_VALUED_KEYS.has(row.key) && row.value_text) {
    return <StateChip state={row.value_text} />;
  }
  // Numbers are grouped at the thousands so the magnitude is readable at a glance
  // (1,800,000 not 1800000).
  if (row.value_int != null) {
    return (
      <span className="font-mono text-xs">
        {row.value_int.toLocaleString("en-US")}
      </span>
    );
  }
  return <span className="font-mono text-xs">{row.value_text ?? "—"}</span>;
}

export function ThresholdsAppendix() {
  const [rows, setRows] = useState<CfgRow[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    fetch("/api/beliefs/cfg")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        // CTL-1317: the server returns { rows } (server.ts /api/beliefs/cfg), NOT
        // { cfg }. Reading the wrong key set rows = undefined, which slipped past
        // the `rows == null` guard below and crashed on rows.length. Read `rows`,
        // and fall back to [] so a future shape drift degrades to "no thresholds".
        return r.json() as Promise<{ rows?: CfgRow[] }>;
      })
      .then((d) => setRows(d.rows ?? []))
      .catch(() => setUnavailable(true));
  }, []);

  const count = rows?.length ?? null;

  return (
    <Collapsible id="thresholds" className="mt-10 rounded-lg border bg-card/40">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-sm">
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span>
          Thresholds{" "}
          <span className="text-muted-foreground">(the tunable numbers)</span>
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground/70">
          cfg{count != null ? ` · ${count} keys` : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4">
          {unavailable ? (
            <p className="text-xs text-muted-foreground">Thresholds unavailable.</p>
          ) : rows == null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No thresholds configured.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="pb-2 text-left font-medium text-muted-foreground text-xs">
                    Key
                  </th>
                  <th className="pb-2 text-right font-medium text-muted-foreground text-xs">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const desc = cfgDescription(row.key);
                  return (
                    <tr
                      key={row.key}
                      id={`cfg-${row.key}`}
                      className="border-b last:border-0 align-top"
                    >
                      <td className="py-2 pr-4">
                        <div className="font-mono text-xs break-all">
                          {row.key}
                        </div>
                        {desc && (
                          <div className="rulebook-prose mt-1 max-w-[64ch] text-[12px] leading-snug text-muted-foreground">
                            {desc}
                          </div>
                        )}
                      </td>
                      <td className="py-2 whitespace-nowrap text-right">
                        <CfgValue row={row} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
