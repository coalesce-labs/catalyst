// process-rail.tsx — CTL-1101 Phase 4. Right-rail governance surface for /process:
// ProcessRail (Legend + Machine Facts + View-source rows), LinearMirrorTable
// (step → linearKey → linearState), and MachineFooter (SHA receipt + changed chip).
import { C, PHASE } from "../../board/board-tokens";
import {
  EDGE_TAXONOMY,
  TAXONOMY_COLOR,
  EFFORT_RULES_PROSE,
  linearMirrorRows,
  linearMirrorCounts,
  shaChanged,
  edgeGroup,
  type FsmDescriptor,
  type TaxonomyGroup,
} from "../../lib/process-model";

// ── Shared micro-styles ───────────────────────────────────────────────────────

const LABEL_STYLE = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase" as const,
  color: C.fgDim,
  marginBottom: 6,
};

const CARD_STYLE = {
  background: C.s2,
  border: `1px solid ${C.borderSubtle}`,
  borderRadius: 6,
  padding: "10px 12px",
  marginBottom: 10,
};

// ── Legend ────────────────────────────────────────────────────────────────────

const GLYPH_SYMBOLS: Record<string, string> = { revive: "↺ revive", "turn-cap": "⏱ turn-cap" };

function LegendCard() {
  const groups = Object.entries(TAXONOMY_COLOR) as [TaxonomyGroup, string][];
  return (
    <div style={CARD_STYLE}>
      <p style={LABEL_STYLE}>Edge legend</p>
      {groups.map(([group, color]) => (
        <div key={group} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span
            style={{
              display: "inline-block",
              width: 20,
              height: 2,
              background: color,
              borderRadius: 1,
              borderTop: group !== "ADVANCE" ? `2px dashed ${color}` : `2px solid ${color}`,
            }}
          />
          <span style={{ fontSize: 11, color: C.fg }}>{group}</span>
        </div>
      ))}
      <div style={{ borderTop: `1px solid ${C.borderSubtle}`, marginTop: 6, paddingTop: 6 }}>
        <p style={{ ...LABEL_STYLE, marginBottom: 4 }}>Node glyphs</p>
        {Object.entries(GLYPH_SYMBOLS).map(([kind, label]) => (
          <div key={kind} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: C.fgMuted }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Machine Facts ─────────────────────────────────────────────────────────────

function MachineFacts({ descriptor }: { descriptor: FsmDescriptor }) {
  const cycle = descriptor.cycles[0];
  return (
    <div style={CARD_STYLE}>
      <p style={LABEL_STYLE}>Machine facts</p>
      <dl style={{ fontSize: 11, color: C.fg, display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px" }}>
        <dt style={{ color: C.fgDim }}>entry</dt>
        <dd style={{ margin: 0 }}>{descriptor.entryPhase}</dd>
        <dt style={{ color: C.fgDim }}>terminal</dt>
        <dd style={{ margin: 0 }}>{descriptor.terminalPhase}</dd>
        {cycle && (
          <>
            <dt style={{ color: C.fgDim }}>cycle</dt>
            <dd style={{ margin: 0 }}>{cycle.members.join(" ⇄ ")} · cap {cycle.cap}</dd>
          </>
        )}
        <dt style={{ color: C.fgDim }}>revive</dt>
        <dd style={{ margin: 0 }}>budget {descriptor.reviveBudget}</dd>
        <dt style={{ color: C.fgDim }}>non-preemptable</dt>
        <dd style={{ margin: 0, fontFamily: C.mono, fontSize: 10 }}>
          {descriptor.nonPreemptable.join(" · ")}
        </dd>
        <dt style={{ color: C.fgDim }}>effort rules</dt>
        <dd style={{ margin: 0, fontFamily: C.mono, fontSize: 10 }}>{EFFORT_RULES_PROSE}</dd>
      </dl>
    </div>
  );
}

// ── MachineFooter ─────────────────────────────────────────────────────────────
// Exported as a plain function (no memo) so process-rail.test.tsx can call it
// directly for tree-walk assertions.

export interface MachineFooterProps {
  descriptorSha: string | null;
  prevSha: string | null;
}

export function MachineFooter({ descriptorSha, prevSha }: MachineFooterProps) {
  const abbrev = descriptorSha ? descriptorSha.slice(0, 7) : "—";
  const changed = descriptorSha ? shaChanged(prevSha, descriptorSha) : false;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderTop: `1px solid ${C.borderSubtle}`,
        fontSize: 11,
        color: C.fgDim,
      }}
    >
      <span title={descriptorSha ?? undefined}>
        rendered from workflow.default.json · sha {abbrev}
      </span>
      {changed && (
        <span
          style={{
            background: C.yellow + "33",
            color: C.yellow,
            border: `1px solid ${C.yellow}55`,
            borderRadius: 3,
            padding: "1px 6px",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          machine changed
        </span>
      )}
    </div>
  );
}

// ── LinearMirrorTable ─────────────────────────────────────────────────────────

function LinearMirrorTable({ descriptor }: { descriptor: FsmDescriptor }) {
  const rows = linearMirrorRows(descriptor);
  const counts = linearMirrorCounts(descriptor);

  return (
    <div style={{ ...CARD_STYLE, marginTop: 10 }}>
      <p style={LABEL_STYLE}>Linear state mirror</p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr>
            {["Step", "Linear key", "Display state"].map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  color: C.fgDim,
                  fontWeight: 600,
                  padding: "2px 6px 4px 0",
                  borderBottom: `1px solid ${C.borderSubtle}`,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.step}>
              <td style={{ padding: "2px 6px 2px 0", fontFamily: C.mono, color: PHASE[r.step] ?? C.fg }}>
                {r.step}
              </td>
              <td style={{ padding: "2px 6px 2px 0", fontFamily: C.mono, color: C.fgMuted }}>
                {r.linearKey ?? <span style={{ color: C.fgDim }}>—</span>}
              </td>
              <td style={{ padding: "2px 0 2px 0", color: C.fg }}>
                {r.linearState ?? <span style={{ color: C.fgDim }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: 8, fontSize: 10, color: C.fgDim }}>
        {counts.steps} steps → {counts.keys} keys → {counts.states} states · Done written at monitor-deploy completion
      </p>
    </div>
  );
}

// ── ProcessRail ───────────────────────────────────────────────────────────────

export interface ProcessRailProps {
  descriptor: FsmDescriptor;
  descriptorSha: string | null;
  prevSha: string | null;
  onOpenSource: (target: { kind: "edge"; from: string; to: string }) => void;
}

export function ProcessRail({ descriptor, descriptorSha, prevSha }: ProcessRailProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
        background: C.s1,
        color: C.fg,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div style={{ display: "flex", gap: 12, padding: "12px 16px", flexWrap: "wrap" as const }}>
        {/* Left column: Legend */}
        <div style={{ minWidth: 180, flex: "0 0 auto" }}>
          <LegendCard />
        </div>
        {/* Center: Machine Facts */}
        <div style={{ flex: 1, minWidth: 240 }}>
          <MachineFacts descriptor={descriptor} />
        </div>
      </div>
      <LinearMirrorTable descriptor={descriptor} />
      <MachineFooter descriptorSha={descriptorSha} prevSha={prevSha} />
    </div>
  );
}
