// Shared static attribute extractors for the OTel audit drift guard (CTL-1009).
// Each extractor reads emitter source text and returns a de-duped array of
// attribute key strings found in that emitter's attribute emission code.
//
// All extractors accept a `tsKeys` set so they can filter out TS-interface-owned
// keys (bash and MJS files reuse TS-defined event.*/catalyst.* attributes without
// "owning" them — those are tracked under emitter:"ts" in the manifest).
//
// Allowed OTel target namespaces for rename-to entries (CTL-1009 §6).
import type { RemediationCluster } from "./otel-attribute-audit.ts";

export const ALLOWED_TARGET_NAMESPACES: readonly string[] = [
  "system.",
  "process.",
  "vcs.",
  "cicd.",
  "deployment.",
  "catalyst.",
  "claude.",
  "linear.",
];

/** Returns true iff the rename-to targetName starts with an allowed OTel namespace. */
export function isAllowedTargetNamespace(target: string): boolean {
  return ALLOWED_TARGET_NAMESPACES.some((ns) => target.startsWith(ns));
}

/** Expected per-cluster rename-to counts (CTL-1009 research §6). */
export const EXPECTED_CLUSTER_COUNTS: Readonly<Record<RemediationCluster, number>> = {
  A: 0,
  B: 9,
  C: 9,
  D: 0,
  E: 0,
  F: 0,
  G: 4,
  H: 1,
};

// ── Extractor helpers ────────────────────────────────────────────────────────

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * Extracts quoted attribute keys from the `Resource` and `Attributes` interface
 * bodies in canonical-event.ts. Uses a line-oriented regex that matches
 *   "key.name"?:
 * inside each interface block. Safe against the value `"catalog"` in
 * `"service.namespace": "catalog"` because values are never followed by `:`.
 */
export function extractTsAttributeKeys(sourceText: string): string[] {
  const keys: string[] = [];
  // Match the body of each named interface (no nested braces in these interfaces).
  const interfaceRe = /export interface (?:Resource|Attributes)\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = interfaceRe.exec(sourceText)) !== null) {
    const body = m[1];
    const keyRe = /"([^"]+)"\??:/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(body)) !== null) {
      keys.push(km[1]);
    }
  }
  return dedup(keys);
}

/**
 * Extracts bash-SPECIFIC attribute keys from canonical-event.sh.
 * Finds all `"key":` patterns in the file (i.e., the jq expression in
 * `build_canonical_line`), then removes any key already owned by the TS
 * interface. The remaining set is what the bash emitter contributes beyond
 * the TS schema.
 */
export function extractShellAttributeKeys(
  sourceText: string,
  tsKeys: ReadonlySet<string>,
): string[] {
  const all: string[] = [];
  const keyRe = /"([^"]+)":/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(sourceText)) !== null) {
    all.push(m[1]);
  }
  return dedup(all).filter((k) => !tsKeys.has(k));
}

/**
 * Extracts MJS-specific attribute keys from a catalyst-agent or execution-core
 * MJS emitter. Captures:
 *   - object-literal keys:  "key.name": value
 *   - put() call keys:      put("key.name", ...)
 * Filters out TS-interface-owned keys.
 */
export function extractMjsAttributeKeys(
  sourceText: string,
  tsKeys: ReadonlySet<string>,
): string[] {
  const all: string[] = [];
  const objRe = /"([^"]+)":/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(sourceText)) !== null) {
    all.push(m[1]);
  }
  const putRe = /\bput\("([^"]+)"/g;
  while ((m = putRe.exec(sourceText)) !== null) {
    all.push(m[1]);
  }
  return dedup(all).filter((k) => !tsKeys.has(k));
}

/**
 * Extracts legacy OTLP attribute keys from emit-otel-event.sh.
 * The script uses jq's `{key:"name", value:{...}}` format rather than
 * dot-notation objects. Matches `key:"name"` patterns and filters TS keys.
 */
export function extractLegacyOtlpKeys(
  sourceText: string,
  tsKeys: ReadonlySet<string>,
): string[] {
  const all: string[] = [];
  // Matches: key:"name" (no spaces — jq compact format in this file)
  const keyRe = /\bkey:"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(sourceText)) !== null) {
    all.push(m[1]);
  }
  return dedup(all).filter((k) => !tsKeys.has(k));
}

/** Canonical table mapping emitter type + file to its extractor. */
export const EMITTER_SOURCES = [
  {
    emitter: "sh" as const,
    relativePath: "../../lib/canonical-event.sh",
    extract: (text: string, tsKeys: ReadonlySet<string>) =>
      extractShellAttributeKeys(text, tsKeys),
  },
  {
    emitter: "mjs" as const,
    relativePath: "../../execution-core/ratelimit-event.mjs",
    extract: (text: string, tsKeys: ReadonlySet<string>) =>
      extractMjsAttributeKeys(text, tsKeys),
  },
  {
    emitter: "mjs" as const,
    relativePath: "../../catalyst-agent/host.mjs",
    extract: (text: string, tsKeys: ReadonlySet<string>) =>
      extractMjsAttributeKeys(text, tsKeys),
  },
  {
    emitter: "mjs" as const,
    relativePath: "../../catalyst-agent/processes.mjs",
    extract: (text: string, tsKeys: ReadonlySet<string>) =>
      extractMjsAttributeKeys(text, tsKeys),
  },
  {
    emitter: "legacy-sh" as const,
    relativePath: "../../emit-otel-event.sh",
    extract: (text: string, tsKeys: ReadonlySet<string>) =>
      extractLegacyOtlpKeys(text, tsKeys),
  },
] as const;
