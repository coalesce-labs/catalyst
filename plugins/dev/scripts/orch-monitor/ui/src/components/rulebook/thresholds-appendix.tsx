// thresholds-appendix.tsx — CTL-1103 Phase 3: fetches /api/beliefs/cfg and
// renders the threshold key/value table. Degrades quietly on fetch failure.
import { useEffect, useState } from "react";

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
        return r.json() as Promise<{ cfg: CfgRow[] }>;
      })
      .then((d) => setRows(d.cfg))
      .catch(() => setUnavailable(true));
  }, []);

  return (
    <div id="thresholds" className="mt-8 rounded-lg border bg-card p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Thresholds (cfg)
      </p>
      {unavailable ? (
        <p className="text-xs text-muted-foreground">Thresholds unavailable.</p>
      ) : rows === null ? (
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
  );
}
