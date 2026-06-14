// reading-pane.test.ts — CTL-1129 acceptance guards for the account-aware
// View-in-Claude pill in reading-pane.tsx (Phase 3).
//
// No jsdom is configured in this test suite, so UI acceptance guards use
// STATIC SOURCE ANALYSIS — the same pattern as home-surface.test.ts. We
// read the .tsx files as text and assert load-bearing structural wiring.
// This locks in the four Gherkin scenarios without requiring a DOM runtime.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const HOME_SRC = join(HERE, "..", "ui", "src", "components", "home");

const readingPaneSrc = readFileSync(join(HOME_SRC, "reading-pane.tsx"), "utf8");
const homeSurfaceSrc = readFileSync(join(HOME_SRC, "home-surface.tsx"), "utf8");

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const paneCode = stripComments(readingPaneSrc);
const homeCode = stripComments(homeSurfaceSrc);

// ════════════════════════════════════════════════════════════════════════════
// CTL-1129 Phase 3: Reading-pane UI — account-aware pill + mismatch warning
// ════════════════════════════════════════════════════════════════════════════

describe("CTL-1129: reading-pane.tsx — operatorAccount prop wiring", () => {
  it("imports accountMismatchFor from reading-pane-model", () => {
    expect(readingPaneSrc).toContain("accountMismatchFor");
  });

  it("ReadingPane accepts an operatorAccount prop", () => {
    expect(paneCode).toMatch(/operatorAccount\s*[=?:]/);
  });

  it("derives mismatchInfo from accountMismatchFor + operatorAccount", () => {
    expect(paneCode).toContain("mismatchInfo");
    expect(paneCode).toContain("accountMismatchFor(viewInClaude");
  });
});

describe("CTL-1129: Scenario 1 (match) — direct open, no mismatch warning rendered", () => {
  it("the pill anchor uses data-view-in-claude to identify the session", () => {
    expect(paneCode).toContain("data-view-in-claude={viewInClaude.sessionId}");
  });

  it("mismatch warning block is gated on mismatchInfo?.mismatch", () => {
    expect(paneCode).toMatch(/mismatchInfo\??\.mismatch/);
  });

  it("data-account-mismatch attribute marks the warning container", () => {
    expect(paneCode).toContain("data-account-mismatch");
  });
});

describe("CTL-1129: Scenario 2 (mismatch) — warning + resume command", () => {
  it("renders the owner account inside the mismatch block", () => {
    expect(paneCode).toContain("mismatchInfo.ownerAccount");
  });

  it("renders the resume command with data-resume-command attribute", () => {
    expect(paneCode).toContain("data-resume-command");
    expect(paneCode).toContain("mismatchInfo.resumeCommand");
  });

  it("the mismatch block uses amber accent (never cyan)", () => {
    expect(paneCode).toMatch(/amber/);
    expect(paneCode).not.toMatch(/data-account-mismatch[\s\S]{0,200}cyan/);
  });

  it("copy button calls navigator.clipboard.writeText with the resume command", () => {
    expect(paneCode).toContain("navigator.clipboard.writeText(mismatchInfo.resumeCommand)");
  });
});

describe("CTL-1129: home-surface.tsx threads operatorAccount from payload", () => {
  it("passes operatorAccount to ReadingPane from payload.daemonAccount", () => {
    expect(homeCode).toMatch(/operatorAccount\s*=\s*\{payload\?\.daemonAccount/);
  });
});
