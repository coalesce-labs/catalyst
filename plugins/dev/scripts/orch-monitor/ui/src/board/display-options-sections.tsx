// display-options-sections.tsx — the uniform popover row primitives for the
// BOARD2 (CTL-906) Display-options popover, extracted so BOARD3 (Swimlanes) /
// BOARD4 (Layout) add a control by DROPPING IN one `<…Row>` rather than editing
// a monolith. Hand-rolled composition of the shadcn primitives (Catalyst-
// specific), token-locked to the dark board surface; the reserved live-signal
// cyan is NEVER used here — active treatment leans on the muted/fg pair the
// board's Seg already uses.
import * as React from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// Row label treatment: the muted uppercase micro-label the board uses for Stat
// labels + Column headers (Board.tsx Stat / Column). Deliberately NOT cyan.
const ROW_LABEL: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#8b93a1",
  fontWeight: 600,
};

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "7px 6px" }}>
      {children}
    </div>
  );
}

/** A labelled single-select segmented row (the workhorse — Group by, Density,
 *  Order, Color, Repo lanes). `options` keys are the stored pref value. */
export function SegRow<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { k: T; label: string }[];
}) {
  return (
    <Row>
      <span style={ROW_LABEL}>{label}</span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        variant="outline"
        size="sm"
        aria-label={label}
      >
        {options.map((o) => (
          <ToggleGroupItem
            key={o.k}
            value={o.k}
            style={{ fontSize: 11.5, color: value === o.k ? "#e6e9ef" : "#8b93a1" }}
          >
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Row>
  );
}

/** A labelled boolean row (Show empty columns). */
export function SwitchRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "9px 6px",
      }}
    >
      <span style={{ ...ROW_LABEL, textTransform: "none", fontSize: 12, letterSpacing: 0, color: "#e6e9ef" }}>
        {label}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** A labelled stacked single-select (reserved for BOARD3 Swimlanes — four+
 *  options read better stacked than as a wide segmented bar). Shipped now so the
 *  popover shape is final; BOARD3 wires it to `prefs.swimlane`. */
export function RadioRow<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { k: T; label: string }[];
}) {
  return (
    <Row>
      <span style={ROW_LABEL}>{label}</span>
      <RadioGroup
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        aria-label={label}
        style={{ gap: 6 }}
      >
        {options.map((o) => {
          const id = `${label}-${o.k}`;
          return (
            <label
              key={o.k}
              htmlFor={id}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#e6e9ef", cursor: "pointer" }}
            >
              <RadioGroupItem id={id} value={o.k} />
              {o.label}
            </label>
          );
        })}
      </RadioGroup>
    </Row>
  );
}
