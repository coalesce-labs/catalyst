// observe-nav.test.ts — CTL-1059 / Pass-B: OBSERVE surface jumps are client-side.
//
// The legacy `window.location.assign("/?surface=…")` full-page-reload calls
// in the Utilization and Host Matrix panels are replaced with client-side
// `navigate({ to: "…" })` calls. These static-source assertions confirm the
// migration: the legacy pattern is gone and the correct router navigate wiring
// is present.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "ui", "src", "components", "observe");
const utilSrc = readFileSync(join(UI, "utilization-surface.tsx"), "utf8");
const hostSrc = readFileSync(join(UI, "host-matrix.tsx"), "utf8");

describe("OBSERVE surface nav is client-side (CTL-1059 / Pass-B)", () => {
  it("no surface jump uses the legacy /?surface= full reload", () => {
    expect(utilSrc).not.toContain('location.assign("/?surface=');
    expect(hostSrc).not.toContain('location.assign("/?surface=');
  });
  it("queue/fleetops jumps use the router navigate to the real routes", () => {
    expect(utilSrc).toContain("useNavigate");
    expect(utilSrc).toMatch(/to:\s*"\/dispatch"/);
    expect(utilSrc).toMatch(/to:\s*"\/fleetops"/);
    expect(hostSrc).toContain("useNavigate");
    expect(hostSrc).toMatch(/to:\s*"\/dispatch"/);
  });
});
