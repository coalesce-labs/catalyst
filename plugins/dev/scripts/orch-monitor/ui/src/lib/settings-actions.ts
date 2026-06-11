import type { ActionEntry } from "./action-registry";

export type GroupBy = "linear" | "phase";
export type Ordering = "priority" | "recent" | "live";
export type Layout = "board" | "list";

export interface SettingsActionHandlers {
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setGroupBy: (g: GroupBy) => void;
  setOrder: (o: Ordering) => void;
  setLayout: (l: Layout) => void;
}

const GROUP_BY: { k: GroupBy; label: string }[] = [
  { k: "linear", label: "Status" },
  { k: "phase", label: "Pipeline" },
];

const ORDER: { k: Ordering; label: string }[] = [
  { k: "priority", label: "Priority" },
  { k: "recent", label: "Recent" },
  { k: "live", label: "Live first" },
];

const LAYOUT: { k: Layout; label: string }[] = [
  { k: "board", label: "Board" },
  { k: "list", label: "List" },
];

export function buildSettingsActions(h: SettingsActionHandlers): ActionEntry[] {
  const settings: ActionEntry[] = [
    {
      id: "settings.theme.toggle",
      title: "Toggle theme (dark / light)",
      keywords: ["dark", "light", "appearance"],
      scope: "global",
      handler: h.toggleTheme,
    },
    {
      id: "settings.sidebar.toggle",
      title: "Toggle navigation panel",
      keywords: ["nav", "sidebar", "collapse"],
      scope: "global",
      handler: h.toggleSidebar,
    },
  ];

  const boardDisplay: ActionEntry[] = [
    ...GROUP_BY.map((o) => ({
      id: `board.groupBy.${o.k}`,
      title: `Group by ${o.label}`,
      keywords: ["group", "board"],
      scope: "board" as const,
      handler: () => h.setGroupBy(o.k),
    })),
    ...ORDER.map((o) => ({
      id: `board.order.${o.k}`,
      title: `Sort by ${o.label}`,
      keywords: ["sort", "order", "board"],
      scope: "board" as const,
      handler: () => h.setOrder(o.k),
    })),
    ...LAYOUT.map((o) => ({
      id: `board.layout.${o.k}`,
      title: `${o.label} view`,
      keywords: ["layout", "view", "board"],
      scope: "board" as const,
      handler: () => h.setLayout(o.k),
    })),
  ];

  return [...settings, ...boardDisplay];
}
