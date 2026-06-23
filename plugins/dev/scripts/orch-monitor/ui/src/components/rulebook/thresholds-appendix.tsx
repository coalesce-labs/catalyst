// thresholds-appendix.tsx — CTL-1103 / CTL-1320: the tunable cfg thresholds, now
// in a closed-by-default Collapsible so the reading column stays calm (the table
// is reference material, not part of the narrative). Degrades quietly on failure.
import { useEffect, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";

interface CfgRow {
  key: string;
  value_int: number | null;
  value_text: string | null;
}

function CfgValue({ row }: { row: CfgRow }) {
  const v = row.value_int != null ? String(row.value_int) : row.value_text;
  return <span className="font-mono text-xs">{v ?? "—"}</span>;
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
                {rows.map((row) => (
                  <tr
                    key={row.key}
                    id={`cfg-${row.key}`}
                    className="border-b last:border-0"
                  >
                    <td className="py-1.5 font-mono text-xs">{row.key}</td>
                    <td className="py-1.5 text-right">
                      <CfgValue row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
