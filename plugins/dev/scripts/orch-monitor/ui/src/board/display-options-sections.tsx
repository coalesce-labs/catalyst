// display-options-sections.tsx — the CTL-930 Phase 2 display-options primitives.
// Replaces SegRow/SwitchRow/RadioRow with quieter Linear-grammar controls:
// LayoutSwitch (icon+label ToggleGroup at top), SelectRow (dropdown with icon+tip),
// ChipToggle (Toggle chip), PropertiesSection (chip group with micro-label).
//
// INVARIANTS honored here:
//   - No cyan (the live signal) anywhere in this file (drift-guard test guards it).
//   - DropdownMenuRadioItem a11y semantics preserved (menuitemradio role).
//   - display-options-sections.tsx filename is stable (guard test imports from it).
import * as React from "react";
import { Check, ChevronDown, Kanban, List } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { C } from "./board-tokens";

// ── LayoutSwitch ─────────────────────────────────────────────────────────────
// Full-width 2-cell toggle: icon + label stacked in each cell.
// "Board" → Kanban icon; "List" → List icon.
const LAYOUT_ICONS = {
  board: Kanban,
  list: List,
} as const;

export function LayoutSwitch<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { k: T; label: string }[];
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label="Layout"
      style={{
        display: "flex",
        width: "100%",
        background: C.s1,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((o) => {
        const Icon = LAYOUT_ICONS[o.k as keyof typeof LAYOUT_ICONS];
        const selected = value === o.k;
        return (
          <ToggleGroupItem
            key={o.k}
            value={o.k}
            aria-label={o.label}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "8px 0",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              background: selected ? C.s3 : "transparent",
              color: selected ? C.fg : C.fgMuted,
              boxShadow: selected ? `inset 0 0 0 1px ${C.border}` : "none",
              fontSize: 11.5,
              fontFamily: "inherit",
              transition: "background 150ms, color 150ms",
            }}
          >
            {Icon && <Icon style={{ width: 16, height: 16 }} aria-hidden />}
            {o.label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

// ── SelectRow ────────────────────────────────────────────────────────────────
// One-line row: [icon 14px] [label 12px muted] [spacer] [value dropdown button].
// Tooltip on the label explains the axis.
// The `hint` slot carries an inline explainer (Phase 3: "filtered to one repo").
export function SelectRow<T extends string>({
  label,
  icon: Icon,
  tip,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  icon?: React.ComponentType<{ style?: React.CSSProperties }>;
  tip?: string;
  value: T;
  onChange: (v: T) => void;
  options: { k: T; label: string }[];
  hint?: string | null;
}) {
  const current = options.find((o) => o.k === value);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 30,
        gap: 6,
        padding: "0 2px",
      }}
    >
      {Icon && (
        <Icon style={{ width: 14, height: 14, color: C.fgDim, flex: "0 0 auto" }} />
      )}
      {tip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              style={{
                fontSize: 12,
                color: C.fgMuted,
                cursor: "default",
                userSelect: "none",
              }}
            >
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{tip}</TooltipContent>
        </Tooltip>
      ) : (
        <span style={{ fontSize: 12, color: C.fgMuted }}>{label}</span>
      )}
      <span style={{ flex: 1 }} />
      {hint && (
        <span style={{ fontSize: 11, color: C.fgDim, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>
          {hint}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${current?.label ?? value}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid transparent",
              background: "transparent",
              color: C.fg,
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "background 150ms",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = C.s3; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            {current?.label ?? value}
            <ChevronDown style={{ width: 12, height: 12, color: C.fgDim }} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          style={{
            minWidth: 168,
            background: C.s2,
            border: `1px solid ${C.border}`,
            color: C.fg,
            fontSize: 12,
          }}
        >
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {options.map((o) => (
              <DropdownMenuRadioItem
                key={o.k}
                value={o.k}
                className="pl-2 [&>span:first-child]:hidden"
                style={{ fontSize: 12 }}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  {o.label}
                  {value === o.k && <Check style={{ width: 14, height: 14, flex: "0 0 auto" }} />}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── ChipToggle ───────────────────────────────────────────────────────────────
// A quiet toggle chip. Pressed: s3 bg + fg text. Unpressed: transparent + muted.
export function ChipToggle({
  label,
  pressed,
  onChange,
  "aria-label": ariaLabel,
}: {
  label: string;
  pressed: boolean;
  onChange: (v: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    <Toggle
      pressed={pressed}
      onPressedChange={onChange}
      aria-label={ariaLabel ?? label}
      style={{
        fontSize: 11.5,
        padding: "2px 9px",
        height: "auto",
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: pressed ? C.s3 : "transparent",
        color: pressed ? C.fg : C.fgMuted,
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "background 150ms, color 150ms",
      }}
    >
      {label}
    </Toggle>
  );
}

// ── PropertiesSection ─────────────────────────────────────────────────────────
// Micro-label "Display properties" + a flex-wrap row of ChipToggles.
export function PropertiesSection({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 2px" }}>
      <span style={{ fontSize: 11, color: C.fgDim, userSelect: "none" }}>
        Display properties
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

/** @deprecated use LayoutSwitch or SelectRow instead — no external callers */
function SegRow<T extends string>({
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
    <SelectRow
      label={label}
      value={value}
      onChange={onChange}
      options={options}
    />
  );
}

/** @deprecated use ChipToggle instead — no external callers */
function SwitchRow({
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
        padding: "6px 2px",
      }}
    >
      <span style={{ fontSize: 12, color: C.fg }}>{label}</span>
      <ChipToggle label={label} pressed={checked} onChange={onChange} />
    </div>
  );
}

/** @deprecated use SelectRow instead — no external callers */
function RadioRow<T extends string>({
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
    <SelectRow
      label={label}
      value={value}
      onChange={onChange}
      options={options}
    />
  );
}
