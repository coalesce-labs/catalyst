import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { AUDIT_MANIFEST } from "../lib/otel-attribute-audit.ts";
import type { Classification, EmitterType } from "../lib/otel-attribute-audit.ts";
import {
  extractTsAttributeKeys,
  isAllowedTargetNamespace,
  EXPECTED_CLUSTER_COUNTS,
  EMITTER_SOURCES,
} from "../lib/attribute-extractors.ts";
import { renderAuditMarkdown } from "../lib/render-attribute-audit.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

const dir = import.meta.dir; // __tests__/
const tsSource = readFileSync(join(dir, "../lib/canonical-event.ts"), "utf8");

// ── Phase 1: TS-interface drift guard ────────────────────────────────────────

describe("otel-attribute-audit — Phase 1: TS interface coverage", () => {
  const tsKeys = extractTsAttributeKeys(tsSource);
  const manifestTsEntries = AUDIT_MANIFEST.filter((e) => e.emitter === "ts");
  const manifestTsKeySet = new Set(manifestTsEntries.map((e) => e.key));
  const tsKeySet = new Set(tsKeys);

  it("extractTsAttributeKeys returns at least 30 keys from Resource + Attributes interfaces", () => {
    expect(tsKeys.length).toBeGreaterThanOrEqual(30);
  });

  it("no_missing_audit_entry: every TS interface key has exactly one manifest entry", () => {
    const missing = tsKeys.filter((k) => !manifestTsKeySet.has(k));
    expect(missing).toEqual([]);
  });

  it("no_orphan_entry: every emitter=ts manifest entry maps to an extracted TS key", () => {
    const orphans = manifestTsEntries.filter((e) => !tsKeySet.has(e.key));
    expect(orphans.map((e) => e.key)).toEqual([]);
  });

  it("classification well-formedness: valid classification on every entry", () => {
    const valid: Classification[] = ["conforming", "rename-to", "legitimately-custom"];
    for (const entry of AUDIT_MANIFEST) {
      expect(valid).toContain(entry.classification);
    }
  });

  it("classification well-formedness: targetName present iff classification === rename-to", () => {
    for (const entry of AUDIT_MANIFEST) {
      if (entry.classification === "rename-to") {
        expect(entry.targetName).toBeTruthy();
      } else {
        expect(entry.targetName).toBeUndefined();
      }
    }
  });

  // Negative-control (skip in CI): uncomment to prove the guard would catch a fake key.
  it.skip("negative-control: extractor catches a fake key added to the interface", () => {
    const fake =
      tsSource.replace(
        'export interface Attributes {',
        'export interface Attributes {\n  "fake.audit.test.key"?: string;',
      );
    const fakeKeys = extractTsAttributeKeys(fake);
    expect(fakeKeys).toContain("fake.audit.test.key");
    // The manifest would be missing this key → drift detected.
    const manifestKeys = new Set(
      AUDIT_MANIFEST.filter((e) => e.emitter === "ts").map((e) => e.key),
    );
    expect(manifestKeys.has("fake.audit.test.key")).toBe(false);
  });
});

// ── Phase 2: Cross-emitter coverage ──────────────────────────────────────────

describe("otel-attribute-audit — Phase 2: cross-emitter coverage", () => {
  const tsKeySet = new Set(extractTsAttributeKeys(tsSource));

  for (const src of EMITTER_SOURCES) {
    const fileText = readFileSync(join(dir, src.relativePath), "utf8");
    const emitter: EmitterType = src.emitter;
    const extracted = src.extract(fileText, tsKeySet);
    const manifestEmitterEntries = AUDIT_MANIFEST.filter((e) => e.emitter === emitter);
    const manifestEmitterKeySet = new Set(manifestEmitterEntries.map((e) => e.key));
    const fileName = src.relativePath.split("/").pop()!;

    describe(`emitter=${emitter} (${fileName})`, () => {
      it("no_missing_audit_entry: every extracted key has a matching manifest entry", () => {
        const missing = extracted.filter((k) => !manifestEmitterKeySet.has(k));
        expect(missing).toEqual([]);
      });

      it("no_orphan_entry: every manifest entry maps to an extracted key", () => {
        // When multiple files share the same emitter (mjs), the manifest entry
        // only needs to appear in one of them — check union across all mjs files.
        if (emitter !== "mjs") {
          const orphans = manifestEmitterEntries.filter(
            (e) => !new Set(extracted).has(e.key),
          );
          expect(orphans.map((e) => e.key)).toEqual([]);
        }
        // mjs orphan check is done in the combined mjs test below.
      });
    });
  }

  it("mjs: every mjs manifest entry appears in at least one mjs source file", () => {
    const allMjsExtracted = new Set<string>();
    for (const src of EMITTER_SOURCES) {
      if (src.emitter !== "mjs") continue;
      const text = readFileSync(join(dir, src.relativePath), "utf8");
      for (const k of src.extract(text, tsKeySet)) {
        allMjsExtracted.add(k);
      }
    }
    const orphans = AUDIT_MANIFEST.filter(
      (e) => e.emitter === "mjs" && !allMjsExtracted.has(e.key),
    );
    expect(orphans.map((e) => e.key)).toEqual([]);
  });
});

describe("otel-attribute-audit — Phase 2: namespace validator", () => {
  it("every rename-to targetName starts with an allowed OTel namespace", () => {
    const bad = AUDIT_MANIFEST.filter(
      (e) => e.classification === "rename-to" && !isAllowedTargetNamespace(e.targetName!),
    );
    expect(bad.map((e) => `${e.key} → ${e.targetName}`)).toEqual([]);
  });
});

describe("otel-attribute-audit — Phase 2: cluster integrity", () => {
  it("every rename-to entry has a remediationCluster", () => {
    const bad = AUDIT_MANIFEST.filter(
      (e) => e.classification === "rename-to" && !e.remediationCluster,
    );
    expect(bad.map((e) => e.key)).toEqual([]);
  });

  it("per-cluster counts match research §6 expectations (A=5 B=9 C=9 D=4 E=3 F=2 G=4 H=1)", () => {
    for (const [cluster, expected] of Object.entries(EXPECTED_CLUSTER_COUNTS)) {
      const actual = AUDIT_MANIFEST.filter((e) => e.remediationCluster === cluster).length;
      expect({ cluster, actual }).toEqual({ cluster, actual: expected });
    }
  });
});

// ── Phase 3: Generated audit document ────────────────────────────────────────

describe("otel-attribute-audit — Phase 3: generated doc", () => {
  it("audit_doc_is_stale: docs/otel-attribute-audit.md matches freshly rendered output", () => {
    const docPath = join(dir, "../docs/otel-attribute-audit.md");
    const onDisk = readFileSync(docPath, "utf8");
    const rendered = renderAuditMarkdown(AUDIT_MANIFEST);
    expect(onDisk).toBe(rendered);
  });

  it("remediation_handoff_complete: rendered doc contains a section for each non-empty cluster A–H", () => {
    const rendered = renderAuditMarkdown(AUDIT_MANIFEST);
    const clusters = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (const c of clusters) {
      const hasEntries = AUDIT_MANIFEST.some((e) => e.remediationCluster === c);
      if (hasEntries) {
        expect(rendered).toContain(`Cluster ${c}`);
      }
    }
  });

  it("hard-cutover migration: rendered doc records hard-cutover and no dual-emit window (operator decision Ryan 2026-06-11)", () => {
    const rendered = renderAuditMarkdown(AUDIT_MANIFEST);
    // Every rename cluster must encode the hard-cutover migration strategy.
    expect(rendered).toContain("hard-cutover");
    // The repudiated dual-emit-window encoding must not reappear.
    expect(rendered).not.toContain("Dual-emit window");
    expect(rendered.toLowerCase()).not.toContain("dual-emit window");
    // The manifest itself must carry no dual-emit-window field.
    expect(JSON.stringify(AUDIT_MANIFEST)).not.toContain("dualEmitWeeks");
  });

  it("PII gate: manifest and rendered doc contain no user_email or user_account_ entries", () => {
    const rendered = renderAuditMarkdown(AUDIT_MANIFEST);
    expect(rendered).not.toContain("user_email");
    expect(rendered).not.toContain("user_account_");
    const piiKeys = AUDIT_MANIFEST.filter(
      (e) => e.key.includes("user_email") || e.key.includes("user_account_"),
    );
    expect(piiKeys).toEqual([]);
  });
});
