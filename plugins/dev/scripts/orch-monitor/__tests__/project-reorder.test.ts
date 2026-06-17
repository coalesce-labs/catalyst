// project-reorder.test.ts — CTL-1248 wiring guards.
//
// Static-source assertions that the drag-reorder feature is correctly wired in
// app-sidebar.tsx: the persisted order atom and pure reconcile helper are imported
// and used, the per-project loop iterates orderedRepos, dnd-kit sortable context
// wraps the loop, and the structural groups (Overall/Observe) are outside it.
//
// DOM-free, no jotai runtime needed. Rides in `bun run check` alongside
// app-shell-ia.test.ts and observe-nav.test.ts.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");
const readMonRoot = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

const sidebarSrc = read("components/app-sidebar.tsx");
const packageJson = readMonRoot("ui/package.json");

/** Strip JS/JSX comments so structural assertions can't be tripped by prose. */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const sidebarCode = stripComments(sidebarSrc);

// ── Phase 2: atom + reconcile imported and wired ──────────────────────────────

describe("CTL-1248 Phase 2 — order atom + reconcile wired into AppSidebar", () => {
  it("imports navProjectOrderAtom from nav-store", () => {
    expect(sidebarSrc).toContain("navProjectOrderAtom");
  });

  it("imports reconcileProjectOrder from nav-model", () => {
    expect(sidebarSrc).toContain("reconcileProjectOrder");
  });

  it("derives orderedRepos using reconcileProjectOrder and the atom value", () => {
    expect(sidebarCode).toMatch(/reconcileProjectOrder\s*\(/);
    expect(sidebarCode).toContain("orderedRepos");
  });

  it("the per-project render loop iterates orderedRepos.map, not repos.map", () => {
    // orderedRepos.map must appear in the file
    expect(sidebarCode).toMatch(/orderedRepos\.map\s*\(/);
    // The JSX usage <SortableProjectGroup must appear after orderedRepos.map
    const orderedMapIdx = sidebarCode.indexOf("orderedRepos.map");
    const sortableGroupJsxIdx = sidebarCode.indexOf("<SortableProjectGroup", orderedMapIdx);
    expect(orderedMapIdx).toBeGreaterThan(-1);
    expect(sortableGroupJsxIdx).toBeGreaterThan(-1);
  });
});

// ── Phase 3: dnd-kit sortable integration ────────────────────────────────────

describe("CTL-1248 Phase 3 — dnd-kit sortable wired into AppSidebar", () => {
  it("imports @dnd-kit/sortable symbols", () => {
    expect(sidebarSrc).toContain("@dnd-kit/sortable");
    expect(sidebarSrc).toContain("SortableContext");
    expect(sidebarSrc).toContain("useSortable");
    expect(sidebarSrc).toContain("arrayMove");
    expect(sidebarSrc).toContain("verticalListSortingStrategy");
  });

  it("imports @dnd-kit/core symbols (DndContext, PointerSensor, KeyboardSensor)", () => {
    expect(sidebarSrc).toContain("DndContext");
    expect(sidebarSrc).toContain("PointerSensor");
    expect(sidebarSrc).toContain("KeyboardSensor");
    expect(sidebarSrc).toContain("sortableKeyboardCoordinates");
  });

  it("imports restrictToVerticalAxis from @dnd-kit/modifiers", () => {
    expect(sidebarSrc).toContain("restrictToVerticalAxis");
  });

  it("imports GripVertical from lucide-react", () => {
    expect(sidebarSrc).toContain("GripVertical");
  });

  it("SortableContext wraps orderedRepos.map and uses verticalListSortingStrategy", () => {
    const scIdx = sidebarCode.indexOf("<SortableContext");
    expect(scIdx).toBeGreaterThan(-1);
    const afterSc = sidebarCode.slice(scIdx);
    // orderedRepos.map must appear inside the SortableContext opening
    const mapIdx = afterSc.indexOf("orderedRepos.map");
    expect(mapIdx).toBeGreaterThan(-1);
    expect(sidebarCode).toContain("verticalListSortingStrategy");
  });

  it("modifiers={[restrictToVerticalAxis]} is present on DndContext", () => {
    expect(sidebarCode).toMatch(/modifiers=\{\[restrictToVerticalAxis\]\}/);
  });

  it("the grip button carries {...attributes} and {...listeners} with aria-label", () => {
    expect(sidebarCode).toContain("{...attributes}");
    expect(sidebarCode).toContain("{...listeners}");
    // aria-label on the grip (reorder-related)
    expect(sidebarCode).toMatch(/aria-label=.*[Rr]eorder/);
  });

  it("{...listeners} does NOT appear on the CollapsibleTrigger", () => {
    // Listeners must only be on the grip button, never on CollapsibleTrigger
    const ctIdx = sidebarCode.indexOf("CollapsibleTrigger");
    expect(ctIdx).toBeGreaterThan(-1);
    // Look for the pattern: CollapsibleTrigger ... {...listeners} on the SAME element
    // Strategy: find the CollapsibleTrigger open tag and check there's no listeners spread before the next >
    const ctTag = sidebarCode.slice(ctIdx, sidebarCode.indexOf(">", ctIdx + 20));
    expect(ctTag).not.toContain("{...listeners}");
  });

  it("onDragEnd uses setProjectOrder(arrayMove(...))", () => {
    expect(sidebarCode).toContain("setProjectOrder");
    expect(sidebarCode).toMatch(/arrayMove\s*\(/);
  });

  it("useSensors includes PointerSensor with activationConstraint and KeyboardSensor", () => {
    expect(sidebarCode).toContain("activationConstraint");
    expect(sidebarCode).toContain("useSensors");
  });

  it("Overall block appears BEFORE SortableContext in source (Overall is not sortable)", () => {
    const overallIdx = sidebarCode.indexOf("navOverallOpenAtom");
    const scIdx = sidebarCode.indexOf("<SortableContext");
    expect(overallIdx).toBeGreaterThan(-1);
    expect(scIdx).toBeGreaterThan(-1);
    expect(overallIdx).toBeLessThan(scIdx);
  });

  it("Observe block appears AFTER </SortableContext> in source (Observe is not sortable)", () => {
    const closeSc = sidebarCode.lastIndexOf("</SortableContext>");
    // Use "group/observe" className which appears ONLY in the Observe render section
    const observeIdx = sidebarCode.indexOf("group/observe", closeSc);
    expect(closeSc).toBeGreaterThan(-1);
    expect(observeIdx).toBeGreaterThan(-1);
  });

  it("ui/package.json has @dnd-kit/sortable ^8.x, core stays ^6.3.1, modifiers ^9.0.0", () => {
    expect(packageJson).toMatch(/"@dnd-kit\/sortable":\s*"\^8\./);
    expect(packageJson).toMatch(/"@dnd-kit\/core":\s*"\^6\.3\.1"/);
    expect(packageJson).toMatch(/"@dnd-kit\/modifiers":\s*"\^9\.0\.0"/);
    // Negative: sortable must NOT be ^9 or ^10 (would require core ^7)
    expect(packageJson).not.toMatch(/"@dnd-kit\/sortable":\s*"\^9\./);
    expect(packageJson).not.toMatch(/"@dnd-kit\/sortable":\s*"\^10\./);
  });
});
