// perspective-toggle.tsx — CTL-1320 → repurposed by CTL-1328.
// The pass-2 swim-lane board dropped the page-level hoisted toggle; the
// Plain English | Datalog | SQL lens now lives PER RULE inside the source
// drawer. This module keeps the shared `Perspective` type and the persisted
// `perspectiveAtom` (renamed storage key, default Datalog so the drawer opens on
// the compiled source — the plain-English description is already shown above the
// toggle). `atomWithStorage` preserves the chosen lens across drawer opens and
// reloads.
import { atomWithStorage } from "jotai/utils";

export type Perspective = "english" | "datalog" | "sql" | "example";

/** The active per-rule source lens, shared by the rule drawer. Persisted so a
 *  chosen lens (e.g. an engineer who lives in Datalog) survives a reload. */
export const perspectiveAtom = atomWithStorage<Perspective>(
  "rulebook-drawer-lens",
  "datalog",
);
