/** Pure surface constants — React-/router-free so they can be imported in tests
 *  without pulling in @tanstack/react-router. surface.ts re-exports from here;
 *  surface-actions.ts imports from here directly. */

export type Surface =
  | "home"
  | "board"
  | "workers"
  | "queue"
  | "telemetry"
  | "utilization"
  | "finops"
  | "fleetops"
  | "devops";

export const SURFACES: readonly Surface[] = [
  "home",
  "board",
  "workers",
  "queue",
  "telemetry",
  "utilization",
  "finops",
  "fleetops",
  "devops",
] as const;

export const SURFACE_LABEL: Record<Surface, string> = {
  home: "Inbox",
  board: "Tickets",
  workers: "Workers",
  queue: "Dispatch",
  telemetry: "Telemetry",
  utilization: "Utilization",
  finops: "FinOps",
  fleetops: "Fleet Ops",
  devops: "DevOps",
};

export const SURFACE_CHORD: Record<string, Surface> = {
  h: "home",
  b: "board",
  w: "workers",
  q: "queue",
  t: "telemetry",
  u: "utilization",
  f: "finops",
  o: "fleetops",
  d: "devops",
};

export const SURFACE_BREADCRUMB: Record<Surface, string[]> = {
  home: ["Overall", "Inbox"],
  board: ["Overall", "Tickets"],
  workers: ["Overall", "Workers"],
  queue: ["Overall", "Dispatch"],
  telemetry: ["Observe", "Telemetry"],
  utilization: ["Observe", "Utilization"],
  finops: ["Observe", "FinOps"],
  fleetops: ["Observe", "Fleet Ops"],
  devops: ["Observe", "DevOps"],
};
