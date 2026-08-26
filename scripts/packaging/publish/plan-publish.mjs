// plan-publish.mjs — CTL-2215 Phase 3: the publish decision, as a pure function.
//
// planSkillsPublish({ currentFiles, publishedFiles }) → no-change / publish /
// inconclusive. Pure: two Map<relPath, Buffer|string> in, a decision out —
// no filesystem, no network, no Date.now(). The push mechanics (clone,
// commit, push, tag) live in the workflow and in run-publish.mjs's file
// materialization; this module only decides WHETHER and WHAT.
//
// The publish is a REPLACE, not a merge (D1/D3 in the plan): a file present
// only in `publishedFiles` is reported in `removed`, never silently kept —
// the same failure `pruneStaleAgentsSkillsDirs` exists to prevent one level
// down, for a skill that lost its classification or whose pack gained a
// safety hook.

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error(`plan-publish: file content must be a Buffer or string, got ${typeof value}`);
}

/**
 * planSkillsPublish({ currentFiles, publishedFiles }) → the publish verdict.
 *
 * `currentFiles` is the freshly-regenerated tree; `publishedFiles` is what
 * the pack repo already carries under `skills/` — both `Map<relPath,
 * Buffer|string>`, relative to that same root, so a key collision means "the
 * same file". Passing `null` for either means "the caller could not read
 * this tree" (a failed clone, an unreadable regenerated output) and yields
 * `inconclusive`, never `no-change` — "I could not look" and "nothing
 * changed" must never collapse into the same answer.
 */
export function planSkillsPublish({ currentFiles, publishedFiles }) {
  if (currentFiles === null) {
    return { action: "inconclusive", reason: "the freshly-regenerated tree could not be read" };
  }
  if (publishedFiles === null) {
    return { action: "inconclusive", reason: "the published tree (coalesce-labs/catalyst-skills skills/) could not be read" };
  }
  if (!(currentFiles instanceof Map) || !(publishedFiles instanceof Map)) {
    return {
      action: "inconclusive",
      reason: "currentFiles and publishedFiles must each be a Map<relPath, Buffer|string> or null",
    };
  }

  const added = [];
  const changed = [];
  const removed = [];

  for (const [relPath, content] of currentFiles) {
    if (!publishedFiles.has(relPath)) {
      added.push(relPath);
      continue;
    }
    const currentBuf = toBuffer(content);
    const publishedBuf = toBuffer(publishedFiles.get(relPath));
    if (!currentBuf.equals(publishedBuf)) {
      changed.push(relPath);
    }
  }

  for (const relPath of publishedFiles.keys()) {
    if (!currentFiles.has(relPath)) {
      removed.push(relPath);
    }
  }

  added.sort();
  changed.sort();
  removed.sort();

  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    return { action: "no-change" };
  }

  return { action: "publish", added, removed, changed };
}

/** renderPublishSummary(plan) → the human-readable one-liner for $GITHUB_STEP_SUMMARY — published/no-change/inconclusive must be legible without reading the raw log. */
export function renderPublishSummary(plan) {
  if (plan.action === "no-change") {
    return "no-change — the regenerated pack is byte-identical to what coalesce-labs/catalyst-skills already carries; nothing pushed.";
  }
  if (plan.action === "inconclusive") {
    return `inconclusive — ${plan.reason}`;
  }
  const parts = [];
  if (plan.added.length > 0) parts.push(`${plan.added.length} added`);
  if (plan.removed.length > 0) parts.push(`${plan.removed.length} removed`);
  if (plan.changed.length > 0) parts.push(`${plan.changed.length} changed`);
  return `publish — ${parts.join(", ")}.`;
}
