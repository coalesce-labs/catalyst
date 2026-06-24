/** Pure surface constants — React-/router-free so they can be imported in tests
 *  without pulling in @tanstack/react-router. surface.ts re-exports from here;
 *  surface-actions.ts imports from here directly. */

export type Surface =
  | "home"
  | "board"
  | "workers"
  | "telemetry"
  | "utilization"
  | "finops"
  | "fleetops"
  | "devops"
  | "process"
  | "rulebook";

export const SURFACES: readonly Surface[] = [
  "home",
  "board",
  "workers",
  "telemetry",
  "utilization",
  "finops",
  "fleetops",
  "devops",
  "process",
  "rulebook",
] as const;

export const SURFACE_LABEL: Record<Surface, string> = {
  home: "Inbox",
  board: "Tickets",
  workers: "Workers",
  telemetry: "Telemetry",
  utilization: "Utilization",
  finops: "FinOps",
  fleetops: "Fleet Ops",
  devops: "DevOps",
  process: "Process",
  // CTL-1328: the "rulebook" surface is presented as "Beliefs" (the section
  // groups Overview · Browse · Monitor). The surface KEY stays "rulebook".
  rulebook: "Beliefs",
};

export const SURFACE_CHORD: Record<string, Surface> = {
  h: "home",
  b: "board",
  w: "workers",
  t: "telemetry",
  u: "utilization",
  f: "finops",
  o: "fleetops",
  d: "devops",
  j: "process",
  r: "rulebook",
};

export const SURFACE_BREADCRUMB: Record<Surface, string[]> = {
  home: ["Overall", "Inbox"],
  board: ["Overall", "Tickets"],
  workers: ["Overall", "Workers"],
  telemetry: ["Observe", "Telemetry"],
  utilization: ["Observe", "Utilization"],
  finops: ["Observe", "FinOps"],
  fleetops: ["Observe", "Fleet Ops"],
  devops: ["Observe", "DevOps"],
  process: ["Reason", "Process"],
  rulebook: ["Reason", "Beliefs"],
};
