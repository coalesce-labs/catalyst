// cluster-signal-ui.test.ts — CTL-898 / SHELL8 UI-contract guards. `bun test` has
// no DOM, so — matching nav-signal-ui.test.ts (CTL-896) — the PURE UI contract
// (lib/cluster-signal.ts: the decode guard, the node dot color/label mapping, and
// the footer-presentation helpers) is unit-tested directly, and the footer-wiring
// scenario (the per-node dots + the single-host no-op + the node filter) is
// asserted by static source analysis of app-sidebar.tsx.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isClusterSignal,
  decodeClusterSignalFrame,
  nodeDotClass,
  nodeStatusLabel,
  shouldShowNodeFilter,
  scopeIncludesNode,
  type ClusterSignal,
} from "../ui/src/lib/cluster-signal";
import {
  ALL_NODES,
  isNodeInScope,
  resolveNodeScope,
  type NodeScope,
} from "../ui/src/lib/node-scope";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

const sidebarSrc = read("components/app-sidebar.tsx");

/** Strip JS/JSX comments so token assertions can't be tripped by prose. */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const sidebarCode = stripComments(sidebarSrc);

const signal = (overrides: Partial<ClusterSignal> = {}): ClusterSignal => ({
  singleHost: true,
  nodes: [{ host: "mini", status: "live" }],
  generatedAt: "2026-06-08T00:00:00.000Z",
  ...overrides,
});

describe("cluster-signal UI contract (CTL-898 / SHELL8)", () => {
  describe("isClusterSignal / decodeClusterSignalFrame", () => {
    it("accepts a well-formed signal", () => {
      expect(isClusterSignal(signal())).toBe(true);
      expect(
        isClusterSignal(signal({ singleHost: false, nodes: [{ host: "a", status: "degraded" }, { host: "b", status: "offline" }] })),
      ).toBe(true);
    });

    it("rejects a frame missing fields or with a bad node status", () => {
      expect(isClusterSignal({ singleHost: true })).toBe(false);
      expect(isClusterSignal({ ...signal(), nodes: [{ host: "a", status: "green" }] })).toBe(false);
      expect(isClusterSignal({ ...signal(), nodes: [{ status: "live" }] })).toBe(false);
      expect(isClusterSignal(null)).toBe(false);
    });

    it("decodes a JSON frame, returning null on garbage (not a throw)", () => {
      expect(decodeClusterSignalFrame(JSON.stringify(signal()))?.nodes[0].host).toBe("mini");
      expect(decodeClusterSignalFrame("{ not json")).toBeNull();
      expect(decodeClusterSignalFrame(JSON.stringify({ singleHost: 1 }))).toBeNull();
    });

    it("CTL-1322: decodes both a frame WITH admission fields and an OLD frame WITHOUT them (back-compat)", () => {
      const withAdmission = signal({
        nodes: [{ host: "mini", status: "live", accepting: false, holdReason: "drain" }],
      });
      expect(isClusterSignal(withAdmission)).toBe(true);
      const decoded = decodeClusterSignalFrame(JSON.stringify(withAdmission));
      expect(decoded?.nodes[0].accepting).toBe(false);
      expect(decoded?.nodes[0].holdReason).toBe("drain");
      // An OLD frame (no admission fields) still decodes — the guard treats them optional.
      expect(isClusterSignal(signal())).toBe(true);
      expect(decodeClusterSignalFrame(JSON.stringify(signal()))?.nodes[0].accepting).toBeUndefined();
    });
  });

  describe("nodeDotClass / nodeStatusLabel", () => {
    it("maps live/degraded/offline to emerald/amber/red — NOT the reserved cyan", () => {
      expect(nodeDotClass("live")).toBe("bg-emerald-500");
      expect(nodeDotClass("degraded")).toBe("bg-amber-500");
      expect(nodeDotClass("offline")).toBe("bg-red-500");
      // the cyan #5be0ff live-signal color is RESERVED — never a node-health dot
      expect(nodeDotClass("live")).not.toContain("5be0ff");
    });

    it("labels each status with the host name for the tooltip/aria", () => {
      expect(nodeStatusLabel("mini", "live")).toContain("mini");
      expect(nodeStatusLabel("mini", "live").toLowerCase()).toContain("healthy");
      expect(nodeStatusLabel("studio", "degraded").toLowerCase()).toContain("degraded");
      expect(nodeStatusLabel("laptop", "offline").toLowerCase()).toContain("offline");
    });
  });

  describe("shouldShowNodeFilter — single-host identity no-op", () => {
    it("is false for a single-host signal (the filter is ABSENT with one node)", () => {
      expect(shouldShowNodeFilter(signal())).toBe(false);
      // even if a single-host signal somehow carried 0/1 nodes
      expect(shouldShowNodeFilter(signal({ nodes: [] }))).toBe(false);
    });

    it("is false until the first frame lands (null ⇒ no filter, no flicker)", () => {
      expect(shouldShowNodeFilter(null)).toBe(false);
    });

    it("is true only when more than one node is running", () => {
      expect(
        shouldShowNodeFilter(
          signal({ singleHost: false, nodes: [{ host: "a", status: "live" }, { host: "b", status: "live" }] }),
        ),
      ).toBe(true);
    });
  });

  describe("scopeIncludesNode — filter the view by node", () => {
    const multi = signal({
      singleHost: false,
      nodes: [{ host: "mini", status: "live" }, { host: "studio", status: "degraded" }],
    });

    it("the All-nodes scope restores the cluster-wide view (every node included)", () => {
      expect(scopeIncludesNode(ALL_NODES, "mini", multi)).toBe(true);
      expect(scopeIncludesNode(ALL_NODES, "studio", multi)).toBe(true);
    });

    it("a focused node scopes the view to that node's work only", () => {
      expect(scopeIncludesNode("mini", "mini", multi)).toBe(true);
      expect(scopeIncludesNode("mini", "studio", multi)).toBe(false);
    });

    it("single-host is an identity no-op: every scope includes the one node", () => {
      const single = signal();
      expect(scopeIncludesNode(ALL_NODES, "mini", single)).toBe(true);
      // a stale focused scope on a now-single-host fleet never hides the one node
      expect(scopeIncludesNode("studio", "mini", single)).toBe(true);
    });
  });
});

describe("node-scope contract (CTL-898 / SHELL8)", () => {
  it("ALL_NODES is the cluster-wide sentinel", () => {
    expect(ALL_NODES).toBe("all");
  });

  it("isNodeInScope: All-nodes includes everything; a focused scope is exact", () => {
    expect(isNodeInScope("all", "mini")).toBe(true);
    expect(isNodeInScope("mini", "mini")).toBe(true);
    expect(isNodeInScope("mini", "studio")).toBe(false);
    // an un-attributed (null ownerHost) ticket is only hidden by a focused scope
    expect(isNodeInScope("all", null)).toBe(true);
    expect(isNodeInScope("mini", null)).toBe(false);
  });

  it("resolveNodeScope: a focused scope on a host no longer in the roster falls back to All", () => {
    const roster = ["mini", "studio"];
    expect(resolveNodeScope("mini", roster)).toBe("mini");
    expect(resolveNodeScope("all", roster)).toBe("all");
    // a node that went away → don't strand the operator on an empty view
    expect(resolveNodeScope("ghost" as NodeScope, roster)).toBe("all");
  });
});

describe("app-sidebar footer wiring (CTL-898 / SHELL8) — static source guards", () => {
  it("the footer consumes the live cluster signal (no hardcoded single dot)", () => {
    expect(sidebarCode).toContain("useClusterSignal");
    expect(sidebarCode).toContain("nodeDotClass");
  });

  it("single-host renders one node dot — the per-node map collapses to today's behavior", () => {
    // the footer iterates the signal's nodes (one for single-host)
    expect(sidebarCode).toMatch(/\.nodes\.map/);
  });

  it("the node filter is gated on shouldShowNodeFilter (absent for single-host)", () => {
    expect(sidebarCode).toContain("shouldShowNodeFilter");
  });
});
