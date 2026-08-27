// frontmatter-standard-doc.test.mjs — CTL-2215 Phase 6 Deliverable 1.
//
// docs/frontmatter-standard.md is prose, not code, so nothing forces it to
// stay in agreement with the registry that actually enforces frontmatter
// keys (providers/local.mjs's SKILL_PORTABLE_KEYS / SKILL_CLAUDE_ONLY_KEYS /
// AGENT_PORTABLE_KEYS / AGENT_CLAUDE_ONLY_KEYS — the sets renderSkill/
// renderAgent throw "unrecognized frontmatter key" against). This test
// extracts the key set the doc's own tables document, per section, and
// asserts it against the real registry in both directions: every recognized
// key documented, and no documented key the registry would reject.
//
// Run: bun test scripts/packaging/__tests__/frontmatter-standard-doc.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "../cli.mjs";
import {
  SKILL_PORTABLE_KEYS,
  SKILL_CLAUDE_ONLY_KEYS,
  AGENT_PORTABLE_KEYS,
  AGENT_CLAUDE_ONLY_KEYS,
} from "../providers/local.mjs";

const DOC_PATH = resolve(repoRoot, "docs/frontmatter-standard.md");

/**
 * extractDocKeysBySection(markdown) → { skills: {portable, claudeOnly}, agents: {portable, claudeOnly} }
 *
 * Scans markdown table rows (lines starting with `|`) within the "## Skills"
 * and "## Agents" sections. A row counts as documenting a key only when its
 * first cell is a lone backtick-wrapped identifier (the Field column) AND
 * some cell in the same row is exactly "Portable" or "Claude-only" — this
 * is what excludes header/separator rows and the prose "Do NOT Include"
 * bullets (which use backticks but are never table rows).
 */
function extractDocKeysBySection(markdown) {
  const lines = markdown.split("\n");
  const sectionStarts = {};
  lines.forEach((line, i) => {
    const m = line.match(/^## (.+)$/);
    if (m) sectionStarts[m[1].trim()] = i;
  });

  function sectionLines(headingPrefix) {
    const headingKey = Object.keys(sectionStarts).find((h) => h.startsWith(headingPrefix));
    if (!headingKey) throw new Error(`no "## ${headingPrefix}" heading found in ${DOC_PATH}`);
    const start = sectionStarts[headingKey];
    const nextHeadingLine = Object.values(sectionStarts)
      .filter((i) => i > start)
      .sort((a, b) => a - b)[0];
    const end = nextHeadingLine ?? lines.length;
    return lines.slice(start, end);
  }

  function extractFromLines(section) {
    const portable = new Set();
    const claudeOnly = new Set();
    for (const line of section) {
      if (!line.trim().startsWith("|")) continue;
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length === 0) continue;
      const keyMatch = cells[0].match(/^`([a-zA-Z-]+)`$/);
      if (!keyMatch) continue;
      const key = keyMatch[1];
      if (cells.includes("Portable")) portable.add(key);
      else if (cells.includes("Claude-only")) claudeOnly.add(key);
    }
    return { portable, claudeOnly };
  }

  return {
    skills: extractFromLines(sectionLines("Skills")),
    agents: extractFromLines(sectionLines("Agents")),
  };
}

function setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

describe("extractDocKeysBySection — the extractor itself, before trusting it on the real doc", () => {
  test("positive control: a fixture doc with a missing key is reported as missing", () => {
    const fixture = [
      "## Skills",
      "",
      "| Field | Type | Portability | Description |",
      "|---|---|---|---|",
      "| `name` | string | Portable | id |",
      "",
      "## Agents",
      "",
      "| Field | Type | Portability | Description |",
      "|---|---|---|---|",
      "| `name` | string | Portable | id |",
    ].join("\n");
    const { skills } = extractDocKeysBySection(fixture);
    expect(skills.portable.has("name")).toBe(true);
    expect(skills.portable.has("description")).toBe(false); // deliberately absent from the fixture
    expect(setEquals(skills.portable, SKILL_PORTABLE_KEYS)).toBe(false);
  });

  test("a row without a Portable/Claude-only cell is not counted (header and separator rows)", () => {
    const fixture = [
      "## Skills",
      "",
      "| Field | Type | Description |",
      "|---|---|---|",
      "| `name` | string | id |",
      "",
      "## Agents",
    ].join("\n");
    const { skills } = extractDocKeysBySection(fixture);
    expect(skills.portable.size).toBe(0);
    expect(skills.claudeOnly.size).toBe(0);
  });

  test("a backticked word in a prose bullet (not a table row) is not counted", () => {
    const fixture = ["## Skills", "", "- `model` — not a real table row", "", "## Agents"].join("\n");
    const { skills } = extractDocKeysBySection(fixture);
    expect(skills.portable.size).toBe(0);
    expect(skills.claudeOnly.size).toBe(0);
  });
});

describe("docs/frontmatter-standard.md agrees with providers/local.mjs's registry", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const extracted = extractDocKeysBySection(doc);

  test("skills — documented portable keys match SKILL_PORTABLE_KEYS exactly", () => {
    expect(setEquals(extracted.skills.portable, SKILL_PORTABLE_KEYS)).toBe(true);
  });

  test("skills — documented Claude-only keys match SKILL_CLAUDE_ONLY_KEYS exactly", () => {
    expect(setEquals(extracted.skills.claudeOnly, SKILL_CLAUDE_ONLY_KEYS)).toBe(true);
  });

  test("agents — documented portable keys match AGENT_PORTABLE_KEYS exactly", () => {
    expect(setEquals(extracted.agents.portable, AGENT_PORTABLE_KEYS)).toBe(true);
  });

  test("agents — documented Claude-only keys match AGENT_CLAUDE_ONLY_KEYS exactly", () => {
    expect(setEquals(extracted.agents.claudeOnly, AGENT_CLAUDE_ONLY_KEYS)).toBe(true);
  });
});
