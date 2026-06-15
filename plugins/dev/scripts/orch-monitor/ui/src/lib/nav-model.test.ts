// nav-model.test.ts — units for the project-grouped nav model (CTL-930 / CTL-944).
// Pure logic, no DOM — run from the ui package:
//   cd ui && bun test src/lib/nav-model.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildNavGroups,
  buildNavGroupsFromProjects,
  breadcrumbFor,
  paletteEntries,
  projectWorkerCount,
  projectQueueDepth,
  overallWorkerCount,
  overallQueueDepth,
  inboxAttentionCount,
  isActiveWorker,
  displayCaseName,
  laneDisplayName,
  type NavGroup,
  type NavProjectDescriptor,
} from "./nav-model";
import type { BoardPayload, BoardWorker, BoardTicket } from "../board/types";

// CTL-1152: a minimal descriptor factory mirroring the server's ProjectDescriptor
// contract (GET /api/projects). The nav only reads repo / name / defaultColor.
const desc = (p: Partial<NavProjectDescriptor> & { repo: string }): NavProjectDescriptor => ({
  key: p.repo.toUpperCase(),
  name: p.repo,
  vcsRepo: null,
  defaultColor: null,
  iconUrl: `/api/repo-icon/${p.repo}`,
  repoRoot: null,
  hasWork: false,
  ...p,
});

const payload = (over: Partial<BoardPayload>): BoardPayload => ({
  generatedAt: "",
  config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
  repos: [],
  workers: [],
  tickets: [],
  queue: [],
  ...over,
});

// Minimal BoardWorker / BoardTicket factories (mirror footer-counts.test.ts) so
// the count-derivation tests can build honest-classification fixtures concisely.
const w = (p: Partial<BoardWorker> & { name: string; ticket: string }): BoardWorker => ({
  tickets: [p.ticket],
  phase: "implement",
  status: "running",
  activeState: "active",
  working: true,
  lastActiveMs: 100,
  repo: "catalyst",
  team: "CTL",
  runtimeMs: 1000,
  costUSD: null,
  ...p,
});

const t = (p: Partial<BoardTicket> & { id: string }): BoardTicket => ({
  title: p.id,
  type: "feature",
  repo: "catalyst",
  team: "CTL",
  phase: "triage",
  status: "queued",
  model: null,
  linearState: "Todo",
  workerStatus: null,
  activeState: null,
  working: false,
  lastActiveMs: null,
  priority: 0,
  estimate: null,
  scope: null,
  project: null,
  costUSD: null,
  tokens: null,
  turns: null,
  phaseCosts: null,
  phaseSummary: [],
  pr: null,
  updatedAt: "2026-06-11T00:00:00Z",
  held: null,
  blockers: [],
  heldSince: null,
  currentPhaseSince: null,
  host: null,
  generation: null,
  attention: null,
  ...p,
});

const repoColors: Record<string, { text: string }> = {
  catalyst: { text: "#4ea1ff" },
  adva: { text: "#a98ee3" },
};

describe("nav-model — buildNavGroups", () => {
  it("returns an Overall group first, then per-repo groups, then Observe last", () => {
    const groups = buildNavGroups(["catalyst", "adva"], repoColors);
    expect(groups[0]?.scope).toBe("all");
    expect(groups[0]?.label).toBe("Overall");
    expect(groups.at(-1)?.scope).toBe("observe");
    // per-repo groups in the middle
    const repoGroups = groups.filter((g) => g.scope !== "all" && g.scope !== "observe");
    expect(repoGroups.map((g) => g.scope)).toEqual(["catalyst", "adva"]);
  });

  it("Overall group has exactly 3 items: Inbox, Tickets, Workers", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const overall = groups.find((g) => g.scope === "all")!;
    expect(overall.items.map((i) => i.target.surface)).toEqual([
      "home", "board", "workers",
    ]);
    expect(overall.items.map((i) => i.label)).toEqual([
      "Inbox", "Tickets", "Workers",
    ]);
  });

  it("per-repo group has the same 3 items scoped to that repo", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const catGroup = groups.find((g) => g.scope === "catalyst")!;
    expect(catGroup).toBeDefined();
    expect(catGroup.label).toBe("catalyst");
    expect(catGroup.dotColor).toBe("#4ea1ff");
    expect(catGroup.items.every((i) => i.target.scope === "catalyst")).toBe(true);
    expect(catGroup.items.map((i) => i.target.surface)).toEqual([
      "home", "board", "workers",
    ]);
  });

  it("Observe group has Telemetry, Utilization, FinOps, Fleet Ops, DevOps", () => {
    const groups = buildNavGroups([], {});
    const observe = groups.find((g) => g.scope === "observe")!;
    expect(observe).toBeDefined();
    const labels = observe.items.map((i) => i.label);
    expect(labels).toContain("Telemetry");
    expect(labels).toContain("Utilization");
    expect(labels).toContain("FinOps");
    expect(labels).toContain("Fleet Ops");
    expect(labels).toContain("DevOps");
  });

  it("with no repos, only Overall and Observe groups", () => {
    const groups = buildNavGroups([], {});
    expect(groups.map((g) => g.scope)).toEqual(["all", "observe"]);
  });

  it("per-repo group with no color config has no dotColor", () => {
    const groups = buildNavGroups(["unknown-repo"], {});
    const grp = groups.find((g) => g.scope === "unknown-repo")!;
    expect(grp.dotColor).toBeUndefined();
  });

  // CTL-961: iconDataUrl is passed through from the repoIcons arg
  it("passes iconDataUrl from repoIcons to the per-repo group", () => {
    const icons: Record<string, string | null> = { catalyst: "data:image/png;base64,abc" };
    const groups = buildNavGroups(["catalyst"], repoColors, icons);
    const grp = groups.find((g) => g.scope === "catalyst")!;
    expect(grp.iconDataUrl).toBe("data:image/png;base64,abc");
  });

  it("sets iconDataUrl to null when icon is null in repoIcons", () => {
    const icons: Record<string, string | null> = { catalyst: null };
    const groups = buildNavGroups(["catalyst"], repoColors, icons);
    const grp = groups.find((g) => g.scope === "catalyst")!;
    expect(grp.iconDataUrl).toBeNull();
  });

  it("sets iconDataUrl to undefined when repoIcons arg is omitted (backward compat)", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const grp = groups.find((g) => g.scope === "catalyst")!;
    expect(grp.iconDataUrl).toBeUndefined();
  });

  it("Overall and Observe groups never have iconDataUrl", () => {
    const icons = { catalyst: "data:image/png;base64,abc" };
    const groups = buildNavGroups(["catalyst"], repoColors, icons);
    const overall = groups.find((g) => g.scope === "all")!;
    const observe = groups.find((g) => g.scope === "observe")!;
    expect(overall.iconDataUrl).toBeUndefined();
    expect(observe.iconDataUrl).toBeUndefined();
  });
});

describe("nav-model — buildNavGroupsFromProjects (CTL-1152)", () => {
  it("descriptors → Overall first, one group per descriptor, Observe last", () => {
    const groups = buildNavGroupsFromProjects([
      desc({ repo: "catalyst", name: "Catalyst" }),
      desc({ repo: "adva", name: "Adva" }),
    ]);
    expect(groups[0]?.scope).toBe("all");
    expect(groups[0]?.label).toBe("Overall");
    expect(groups.at(-1)?.scope).toBe("observe");
    const repoGroups = groups.filter((g) => g.scope !== "all" && g.scope !== "observe");
    // group scope = descriptor.repo (short name); label = descriptor.name.
    expect(repoGroups.map((g) => g.scope)).toEqual(["catalyst", "adva"]);
    expect(repoGroups.map((g) => g.label)).toEqual(["Catalyst", "Adva"]);
  });

  it("wires descriptor.defaultColor through NAMED_COLORS to a DEFINED group.dotColor (regression guard for the always-undefined repoColors={} bug)", () => {
    const groups = buildNavGroupsFromProjects([
      desc({ repo: "catalyst", name: "Catalyst", defaultColor: "green" }),
    ]);
    const grp = groups.find((g) => g.scope === "catalyst")!;
    // "green" → NAMED_COLORS.green.text ("#b5d67a") — defined, NOT undefined.
    expect(grp.dotColor).toBe("#b5d67a");
    expect(grp.dotColor).toBeDefined();
  });

  it("a descriptor with no defaultColor resolves to an undefined dotColor (neutral)", () => {
    const groups = buildNavGroupsFromProjects([
      desc({ repo: "mystery", name: "Mystery", defaultColor: null }),
    ]);
    const grp = groups.find((g) => g.scope === "mystery")!;
    expect(grp.dotColor).toBeUndefined();
  });

  it("passes iconDataUrl through from the repoIcons arg, keyed by descriptor.repo", () => {
    const icons: Record<string, string | null> = { catalyst: "data:image/png;base64,abc" };
    const groups = buildNavGroupsFromProjects(
      [desc({ repo: "catalyst", name: "Catalyst" })],
      icons,
    );
    const grp = groups.find((g) => g.scope === "catalyst")!;
    expect(grp.iconDataUrl).toBe("data:image/png;base64,abc");
  });

  it("with an empty descriptor list → just Overall + Observe (the empty-state shape the sidebar special-cases)", () => {
    const groups = buildNavGroupsFromProjects([]);
    expect(groups.map((g) => g.scope)).toEqual(["all", "observe"]);
  });

  it("threads descriptor.hasWork onto the group so the sidebar can default idle projects collapsed + badge active ones (CTL-1152)", () => {
    const groups = buildNavGroupsFromProjects([
      desc({ repo: "catalyst", name: "Catalyst", hasWork: true }),
      desc({ repo: "evergreen", name: "Evergreen", hasWork: false }),
    ]);
    expect(groups.find((g) => g.scope === "catalyst")?.hasWork).toBe(true);
    expect(groups.find((g) => g.scope === "evergreen")?.hasWork).toBe(false);
    // Overall / Observe carry no hasWork (treated as always-open by the sidebar).
    expect(groups.find((g) => g.scope === "all")?.hasWork).toBeUndefined();
    expect(groups.find((g) => g.scope === "observe")?.hasWork).toBeUndefined();
  });

  it("per-descriptor group has the same 3 OPERATE items scoped to that repo", () => {
    const groups = buildNavGroupsFromProjects([desc({ repo: "catalyst", name: "Catalyst" })]);
    const grp = groups.find((g) => g.scope === "catalyst")!;
    expect(grp.items.every((i) => i.target.scope === "catalyst")).toBe(true);
    expect(grp.items.map((i) => i.target.surface)).toEqual(["home", "board", "workers"]);
  });
});

describe("nav-model — breadcrumbFor", () => {
  it("overall home → ['Overall', 'Inbox']", () => {
    expect(breadcrumbFor("home", "all")).toEqual(["Overall", "Inbox"]);
  });

  it("overall board → ['Overall', 'Tickets']", () => {
    expect(breadcrumbFor("board", "all")).toEqual(["Overall", "Tickets"]);
  });

  it("overall workers → ['Overall', 'Workers']", () => {
    expect(breadcrumbFor("workers", "all")).toEqual(["Overall", "Workers"]);
  });

  it("project board → ['catalyst', 'Tickets']", () => {
    expect(breadcrumbFor("board", "catalyst")).toEqual(["catalyst", "Tickets"]);
  });
});

describe("nav-model — paletteEntries", () => {
  it("returns entries for every group (not observe)", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const entries = paletteEntries(groups);
    // Should have Overall + catalyst entries (Observe skipped or included)
    expect(entries.length).toBeGreaterThan(0);
    // Overall group is first
    expect(entries[0]?.group).toBe("Overall");
    expect(entries[0]?.items.length).toBe(3);
  });

  it("each entry item has a target with surface and scope", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const entries = paletteEntries(groups);
    const overall = entries.find((e) => e.group === "Overall")!;
    for (const item of overall.items) {
      expect(item.target.surface).toBeDefined();
      expect(item.target.scope).toBe("all");
    }
  });
});

describe("nav-model — isActiveWorker", () => {
  it("is true ONLY for activeState === 'active' (dead/stale/stuck/null excluded)", () => {
    expect(isActiveWorker(w({ name: "a", ticket: "CTL-1", activeState: "active" }))).toBe(true);
    expect(isActiveWorker(w({ name: "b", ticket: "CTL-2", activeState: "dead" }))).toBe(false);
    expect(isActiveWorker(w({ name: "c", ticket: "CTL-3", activeState: "stuck" }))).toBe(false);
    expect(isActiveWorker(w({ name: "d", ticket: "CTL-4", activeState: null }))).toBe(false);
  });
});

describe("nav-model — projectWorkerCount", () => {
  it("counts only active workers for the given repo (dead/stale excluded)", () => {
    // adva: 3 active. catalyst: 1 active + 1 dead + 1 stale → 1 (honest count).
    const p = payload({
      workers: [
        w({ name: "a1", ticket: "ADV-1", repo: "adva", team: "ADV", activeState: "active" }),
        w({ name: "a2", ticket: "ADV-2", repo: "adva", team: "ADV", activeState: "active" }),
        w({ name: "a3", ticket: "ADV-3", repo: "adva", team: "ADV", activeState: "active" }),
        w({ name: "c1", ticket: "CTL-1", repo: "catalyst", activeState: "active" }),
        w({ name: "c2", ticket: "CTL-2", repo: "catalyst", activeState: "dead", working: false }),
        w({ name: "c3", ticket: "CTL-3", repo: "catalyst", activeState: null, working: false }),
      ],
    });
    // Gherkin: adva 3 active, catalyst 1 active.
    expect(projectWorkerCount(p, "adva")).toBe(3);
    expect(projectWorkerCount(p, "catalyst")).toBe(1);
    // A project with zero active workers → 0 (caller hides the dot + count).
    expect(projectWorkerCount(p, "unknown")).toBe(0);
  });

  it("returns 0 when a repo's only workers are dead/stale (zero hides)", () => {
    const p = payload({
      workers: [
        w({ name: "d1", ticket: "ADV-1", repo: "adva", team: "ADV", activeState: "dead", working: false }),
        w({ name: "d2", ticket: "ADV-2", repo: "adva", team: "ADV", activeState: null, working: false }),
      ],
    });
    expect(projectWorkerCount(p, "adva")).toBe(0);
  });
});

describe("nav-model — overallWorkerCount", () => {
  it("counts active workers fleet-wide, excluding dead/stale (CTL-1032 honesty)", () => {
    // 8 workers, 6 genuinely active, 2 dead/stale → 6 (the Gherkin's headline case).
    const p = payload({
      workers: [
        w({ name: "a", ticket: "CTL-1", activeState: "active" }),
        w({ name: "b", ticket: "CTL-2", activeState: "active" }),
        w({ name: "c", ticket: "ADV-1", repo: "adva", team: "ADV", activeState: "active" }),
        w({ name: "d", ticket: "ADV-2", repo: "adva", team: "ADV", activeState: "active" }),
        w({ name: "e", ticket: "CTL-3", activeState: "active" }),
        w({ name: "f", ticket: "CTL-4", activeState: "active" }),
        w({ name: "g", ticket: "CTL-5", activeState: "dead", working: false }),
        w({ name: "h", ticket: "CTL-6", activeState: null, working: false }),
      ],
    });
    expect(overallWorkerCount(p)).toBe(6);
  });

  it("is 0 with no active workers", () => {
    expect(overallWorkerCount(payload({}))).toBe(0);
  });
});

describe("nav-model — overallQueueDepth", () => {
  it("counts all queue items across the fleet", () => {
    const p = payload({
      queue: [
        { repo: "catalyst" } as unknown as BoardPayload["queue"][0],
        { repo: "adva" } as unknown as BoardPayload["queue"][0],
        { repo: "catalyst" } as unknown as BoardPayload["queue"][0],
      ],
    });
    expect(overallQueueDepth(p)).toBe(3);
  });

  it("is 0 when nothing is waiting", () => {
    expect(overallQueueDepth(payload({}))).toBe(0);
  });
});

describe("nav-model — projectQueueDepth", () => {
  it("counts queue items for the given repo", () => {
    const p = payload({
      queue: [
        { id: "CTL-1", ticket: "CTL-1", title: "t", repo: "catalyst", team: "CTL", priority: 2, estimate: null, scope: null, linearState: "Todo", type: "feature", rank: "a" } as unknown as BoardPayload["queue"][0],
        { id: "CTL-2", ticket: "CTL-2", title: "t", repo: "catalyst", team: "CTL", priority: 2, estimate: null, scope: null, linearState: "Todo", type: "feature", rank: "b" } as unknown as BoardPayload["queue"][0],
        { id: "ADV-1", ticket: "ADV-1", title: "t", repo: "adva", team: "ADV", priority: 2, estimate: null, scope: null, linearState: "Todo", type: "feature", rank: "c" } as unknown as BoardPayload["queue"][0],
      ],
    });
    expect(projectQueueDepth(p, "catalyst")).toBe(2);
    expect(projectQueueDepth(p, "adva")).toBe(1);
    expect(projectQueueDepth(p, "unknown")).toBe(0);
  });
});

describe("nav-model — inboxAttentionCount", () => {
  it("counts the 'needs you' bucket (attention ∪ blocked ∪ waiting), not total inbox", () => {
    // adva: 1 waiting-on-you (attention). catalyst: 0 needs-you (1 running only).
    const p = payload({
      tickets: [
        t({ id: "ADV-1", repo: "adva", team: "ADV", attention: "waiting-on-you" }),
        t({ id: "CTL-1", repo: "catalyst", activeState: "active", working: true, status: "running" }),
      ],
    });
    // Gherkin: adva inbox shows 1, catalyst shows none, overall shows the total (1).
    expect(inboxAttentionCount(p, "adva")).toBe(1);
    expect(inboxAttentionCount(p, "catalyst")).toBe(0);
    expect(inboxAttentionCount(p, "all")).toBe(1);
  });

  it("sums attention + blocked + waiting across the fleet for the overall row", () => {
    const p = payload({
      tickets: [
        t({ id: "ADV-1", repo: "adva", team: "ADV", attention: "needs-human" }),
        t({ id: "CTL-1", repo: "catalyst", held: "blocked" }),
        t({ id: "CTL-2", repo: "catalyst", held: "waiting" }),
        t({ id: "CTL-3", repo: "catalyst", activeState: "active", working: true, status: "running" }),
      ],
    });
    expect(inboxAttentionCount(p, "all")).toBe(3);
    expect(inboxAttentionCount(p, "catalyst")).toBe(2);
    expect(inboxAttentionCount(p, "adva")).toBe(1);
  });

  it("is 0 when nothing needs the operator (badge hidden — clears live)", () => {
    const p = payload({
      tickets: [
        t({ id: "CTL-1", repo: "catalyst", activeState: "active", working: true, status: "running" }),
      ],
    });
    expect(inboxAttentionCount(p, "all")).toBe(0);
    expect(inboxAttentionCount(p, "catalyst")).toBe(0);
  });
});

// ── CTL-1012: display-name helpers (the ONE source of spelled-out entity names) ──

describe("nav-model — displayCaseName", () => {
  it("display-cases a single-word repo short-name", () => {
    expect(displayCaseName("adva")).toBe("Adva");
    expect(displayCaseName("catalyst")).toBe("Catalyst");
  });
  it("title-cases each token of a multi-word short-name", () => {
    expect(displayCaseName("rightsite-cloud")).toBe("Rightsite Cloud");
    expect(displayCaseName("my_app")).toBe("My App");
    expect(displayCaseName("foo bar")).toBe("Foo Bar");
  });
  it("fail-soft on empty/blank/nullish input → ''", () => {
    expect(displayCaseName("")).toBe("");
    expect(displayCaseName(null)).toBe("");
    expect(displayCaseName(undefined)).toBe("");
    expect(displayCaseName("   ")).toBe("");
  });
});

describe("nav-model — laneDisplayName", () => {
  it("team axis: spelled-out brand + bare key in parens ('Adva (ADV)')", () => {
    expect(laneDisplayName("team", "ADV", "ADV", "adva")).toBe("Adva (ADV)");
    expect(laneDisplayName("team", "CTL", "CTL", "catalyst")).toBe("Catalyst (CTL)");
  });
  it("team axis with no repo falls back to the bare key/label", () => {
    expect(laneDisplayName("team", "ADV", "ADV", null)).toBe("ADV");
    expect(laneDisplayName("team", "ADV", "ADV", undefined)).toBe("ADV");
  });
  it("repo axis: display-cased short-name; falls back to the label when blank", () => {
    expect(laneDisplayName("repo", "adva", "adva", "adva")).toBe("Adva");
    expect(laneDisplayName("repo", "catalyst", "catalyst", "catalyst")).toBe("Catalyst");
  });
  it("project axis: the project name verbatim (already human-readable)", () => {
    expect(laneDisplayName("project", "Orchestration Monitor UX", "Orchestration Monitor UX", "catalyst")).toBe(
      "Orchestration Monitor UX",
    );
  });
  it("host/none axes: the label verbatim", () => {
    expect(laneDisplayName("host", "id-mini", "mini", "catalyst")).toBe("mini");
    expect(laneDisplayName("none", "__catalyst_unassigned__", "", "catalyst")).toBe("");
  });
  it("the catch-all lane keeps its 'Unassigned'/'No team' label on every axis", () => {
    expect(laneDisplayName("team", "__catalyst_unassigned__", "No team", null)).toBe("No team");
    expect(laneDisplayName("repo", "__catalyst_unassigned__", "Unassigned", null)).toBe("Unassigned");
    expect(laneDisplayName("project", "__catalyst_unassigned__", "Unassigned", null)).toBe("Unassigned");
  });
});
