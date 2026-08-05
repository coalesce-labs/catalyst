// account-strip.ts — CTL-1653. The HUD sibling of the web account
// indicator/banner (ui/src/hooks/account-signal-lib.ts). Pure Ink text builders:
// a quiet-while-ok one-row strip + a loud round-border overlay when the active
// binding window is `rejected`.
//
// MIRROR, not import: the cli bundle never reaches into ui/src (each surface —
// server lib, web ui, cli hud — keeps its own hand-synced copy of the shape +
// vocabulary, exactly as cli/lib mirrors server shapes and ui/src/lib/cluster-
// signal.ts mirrors lib/cluster-signal.mjs). The status→tone semantics here are
// byte-for-byte the same vocabulary as account-signal-lib.ts; keep them in sync.
//
// error ≠ rejected: a transport `error` is the sensor being broken (dim, never
// inverse); only `rejected` (account exhausted) goes loud (inverse strip + overlay).

/** One rate-limit window (token-free). */
export interface AccountStripWindow {
  pct?: number;
  resetsAt?: string | null;
}

/** The minimal AccountSignal shape the HUD strip needs (mirror of AccountSignal). */
export interface AccountStripSignal {
  status: string;
  active?: {
    label?: string | null;
    bindingWindow?: string | null;
    fiveHour?: AccountStripWindow | null;
    sevenDay?: AccountStripWindow | null;
    error?: string | null;
  } | null;
  siblingWithHeadroom?: { label?: string | null } | null;
}

/** Short label for a binding window (five_hour → "5h", seven_day → "7d"). */
function bindingWindowShort(bindingWindow?: string | null): string {
  if (bindingWindow === "five_hour") return "5h";
  if (bindingWindow === "seven_day") return "7d";
  return "";
}

/** The window the binding claim points at (five_hour → active.fiveHour). */
function bindingWindowOf(active: AccountStripSignal["active"]): AccountStripWindow | null {
  if (!active) return null;
  if (active.bindingWindow === "five_hour") return active.fiveHour ?? null;
  if (active.bindingWindow === "seven_day") return active.sevenDay ?? null;
  return null;
}

/**
 * accountStripText — the compact one-row strip. Quiet (gray) while ok/unknown,
 * yellow while degraded, dim while error, and INVERSE red while rejected (the
 * `header-chips.ts` inverse idiom). Names the active handle + binding-window pct.
 */
export function accountStripText(signal: AccountStripSignal | null | undefined): {
  text: string;
  color: string;
  inverse: boolean;
} {
  if (!signal) return { text: "account —", color: "gray", inverse: false };
  const active = signal.active;
  const status = signal.status;

  if (!active || (!active.label && status === "unknown")) {
    return { text: "acct: none", color: "gray", inverse: false };
  }
  if (status === "error") {
    return { text: `acct ${active.label ?? "?"}: error`, color: "gray", inverse: false };
  }
  const win = bindingWindowShort(active.bindingWindow);
  const w = bindingWindowOf(active);
  const pct = typeof w?.pct === "number" ? `${w.pct}%` : "";
  const suffix = [win, pct].filter(Boolean).join(" ");
  const text = `acct ${active.label ?? "?"}${suffix ? ` · ${suffix}` : ""}`;

  if (status === "rejected") return { text, color: "red", inverse: true };
  if (status === "degraded") return { text, color: "yellow", inverse: false };
  return { text, color: "gray", inverse: false }; // ok / anything quiet
}

/**
 * accountOverlayLines — the loud round-border overlay lines. Empty unless the
 * active binding window is `rejected`; otherwise the exhausted / reset / sibling
 * lines naming the reset time + a sibling account with headroom.
 */
export function accountOverlayLines(signal: AccountStripSignal | null | undefined): string[] {
  if (!signal || signal.status !== "rejected") return [];
  const active = signal.active ?? null;
  const who = active?.label ?? "the active account";
  const w = bindingWindowOf(active);
  // ISO date portion (YYYY-MM-DD) — deterministic + locale-free for the TUI.
  const resetsAt = w?.resetsAt ?? null;
  const resetLabel = resetsAt ? resetsAt.slice(0, 16).replace("T", " ") : "an unknown time";
  const lines = [`Claude account ${who} is out of budget.`, `Resets ${resetLabel}.`];
  if (signal.siblingWithHeadroom?.label) {
    lines.push(`Switch to ${signal.siblingWithHeadroom.label} (has headroom).`);
  }
  return lines;
}
