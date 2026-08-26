#!/usr/bin/env bun
// run-publish.mjs — CTL-2215 Phase 3: the publish-skills.yml driver.
//
// Reads the freshly-regenerated `.agents/skills/` tree and the cloned pack
// repo's `skills/` tree into two Maps, asks plan-publish.mjs's pure
// planSkillsPublish() what to do, and — on `publish` — materializes the
// decision onto disk inside the cloned pack repo, replacing `skills/`
// wholesale (D1/D3 in the plan). It never touches git: clone, commit, push,
// and tag stay bash steps in the workflow, so SKILLS_PUBLISH_TOKEN is never
// threaded through this script's environment at all (minimal-touch
// credential handling — the token only ever appears in the two bash steps
// that actually need it).
//
// Usage: bun scripts/packaging/publish/run-publish.mjs --pack-dir <path>
// Exit 0 on no-change or publish (materialized onto disk, not yet
// committed); exit 1 on inconclusive. Writes $GITHUB_OUTPUT (action, plus
// added/removed/changed counts) and appends to $GITHUB_STEP_SUMMARY when
// those env vars are set — both are optional, so a local/manual run just
// prints to stdout.

import { readdirSync, statSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, relative, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { planSkillsPublish, renderPublishSummary } from "./plan-publish.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function listFilesRecursive(absDir) {
  const out = [];
  for (const entry of readdirSync(absDir)) {
    const full = join(absDir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** readTree(absDir) → Map<relPath, Buffer> for every file under absDir, or an empty Map if absDir does not exist (a legitimate "nothing published yet" state — never conflated with "could not read"). */
function readTree(absDir) {
  const map = new Map();
  if (!existsSync(absDir)) return map;
  for (const abs of listFilesRecursive(absDir)) {
    const relPath = relative(absDir, abs).split(sep).join("/");
    map.set(relPath, readFileSync(abs));
  }
  return map;
}

/** materializePublish(packDir, currentFiles) — replaces packDir/skills WHOLESALE with currentFiles' contents. A replace, not a merge, so a de-classified skill cannot linger. */
function materializePublish(packDir, currentFiles) {
  const skillsDir = resolve(packDir, "skills");
  rmSync(skillsDir, { recursive: true, force: true });
  for (const [relPath, content] of currentFiles) {
    const abs = resolve(skillsDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function parseArgs(argv) {
  const idx = argv.indexOf("--pack-dir");
  if (idx === -1 || !argv[idx + 1]) {
    throw new Error("run-publish: --pack-dir <path> is required");
  }
  return { packDir: resolve(argv[idx + 1]) };
}

function writeGithubOutput(pairs) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  appendFileSync(
    outPath,
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}

function writeGithubStepSummary(text) {
  const outPath = process.env.GITHUB_STEP_SUMMARY;
  if (!outPath) return;
  appendFileSync(outPath, text + "\n");
}

function main() {
  const { packDir } = parseArgs(process.argv.slice(2));

  let currentFiles;
  try {
    currentFiles = readTree(resolve(repoRoot, ".agents/skills"));
  } catch (err) {
    currentFiles = null;
    console.error(`run-publish: could not read the regenerated .agents/skills/ tree: ${err.message}`);
  }

  let publishedFiles;
  try {
    publishedFiles = readTree(resolve(packDir, "skills"));
  } catch (err) {
    publishedFiles = null;
    console.error(`run-publish: could not read ${packDir}/skills: ${err.message}`);
  }

  const plan = planSkillsPublish({ currentFiles, publishedFiles });
  const summary = renderPublishSummary(plan);
  console.log(summary);
  writeGithubStepSummary(`### publish-skills\n\n${summary}\n`);

  if (plan.action === "inconclusive") {
    console.error(`::error::${summary}`);
    writeGithubOutput({ action: "inconclusive" });
    process.exit(1);
  }

  if (plan.action === "no-change") {
    writeGithubOutput({ action: "no-change" });
    return;
  }

  // action === "publish" — materialize onto disk; the workflow's own bash
  // steps own git add/commit/push/tag from here.
  materializePublish(packDir, currentFiles);
  writeGithubOutput({
    action: "publish",
    added_count: String(plan.added.length),
    removed_count: String(plan.removed.length),
    changed_count: String(plan.changed.length),
  });
  for (const relPath of plan.added) console.log(`  + ${relPath}`);
  for (const relPath of plan.removed) console.log(`  - ${relPath}`);
  for (const relPath of plan.changed) console.log(`  ~ ${relPath}`);
}

if (import.meta.main) {
  main();
}

export { readTree, materializePublish };
