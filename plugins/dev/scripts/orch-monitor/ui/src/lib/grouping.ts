import type { OrchestratorState, SessionState } from "./types";

export type GroupingMode = "flat" | "repo" | "ticket";

interface SidebarGroup {
  key: string;
  label: string;
  orchestrators: OrchestratorState[];
  activeSessions: SessionState[];
  recentDead: SessionState[];
}

export function repoKey(path: string | null): string {
  if (!path) return "other";
  const segments = path.replace(/\/+$/, "").split("/");
  if (segments.length < 2) return segments[0] || "other";
  return segments.slice(-2).join("/");
}

function orchWorkspaceKey(orch: OrchestratorState): string {
  if (orch.workspace && orch.workspace !== "default") return orch.workspace;
  return repoKey(orch.path);
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : path;
}

function sessionWorkspaceKey(
  cwd: string | null,
  orchParentToWorkspace: Map<string, string>,
): string {
  if (!cwd) return "other";
  for (const [parent, workspace] of orchParentToWorkspace) {
    if (cwd.startsWith(parent + "/") || cwd === parent) return workspace;
  }
  return repoKey(cwd);
}

function groupByTicket(
  orchestrators: OrchestratorState[],
  activeSessions: SessionState[],
  recentDead: SessionState[],
): SidebarGroup[] {
  const UNLINKED = "unlinked";
  const map = new Map<string, SidebarGroup>();

  const getOrCreate = (key: string): SidebarGroup => {
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        label: key === UNLINKED ? "Unlinked" : key,
        orchestrators: [],
        activeSessions: [],
        recentDead: [],
      };
      map.set(key, group);
    }
    return group;
  };

  for (const orch of orchestrators) {
    const workerTickets = Object.keys(orch.workers);
    if (workerTickets.length === 0) {
      getOrCreate(UNLINKED).orchestrators.push(orch);
    } else {
      for (const ticket of workerTickets) {
        getOrCreate(ticket).orchestrators.push(orch);
      }
    }
  }

  for (const session of activeSessions) {
    getOrCreate(session.ticket ?? UNLINKED).activeSessions.push(session);
  }

  for (const session of recentDead) {
    getOrCreate(session.ticket ?? UNLINKED).recentDead.push(session);
  }

  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    if (a.key === UNLINKED) return 1;
    if (b.key === UNLINKED) return -1;
    return a.key.localeCompare(b.key);
  });

  return groups;
}

export function groupSidebarItems(
  orchestrators: OrchestratorState[],
  activeSessions: SessionState[],
  recentDead: SessionState[],
  mode: GroupingMode,
): SidebarGroup[] {
  if (mode === "flat") {
    return [
      {
        key: "__flat__",
        label: "",
        orchestrators,
        activeSessions,
        recentDead,
      },
    ];
  }

  if (mode === "ticket") {
    return groupByTicket(orchestrators, activeSessions, recentDead);
  }

  const orchParentToWorkspace = new Map<string, string>();
  for (const orch of orchestrators) {
    const ws = orchWorkspaceKey(orch);
    const parent = parentDir(orch.path);
    orchParentToWorkspace.set(parent, ws);
  }

  const map = new Map<string, SidebarGroup>();

  const getOrCreate = (key: string): SidebarGroup => {
    let group = map.get(key);
    if (!group) {
      group = { key, label: key, orchestrators: [], activeSessions: [], recentDead: [] };
      map.set(key, group);
    }
    return group;
  };

  for (const orch of orchestrators) {
    getOrCreate(orchWorkspaceKey(orch)).orchestrators.push(orch);
  }

  for (const session of activeSessions) {
    getOrCreate(sessionWorkspaceKey(session.cwd, orchParentToWorkspace)).activeSessions.push(session);
  }

  for (const session of recentDead) {
    getOrCreate(sessionWorkspaceKey(session.cwd, orchParentToWorkspace)).recentDead.push(session);
  }

  const groups = Array.from(map.values());
  groups.sort((a, b) => {
    if (a.key === "other") return 1;
    if (b.key === "other") return -1;
    return a.key.localeCompare(b.key);
  });

  return groups;
}
