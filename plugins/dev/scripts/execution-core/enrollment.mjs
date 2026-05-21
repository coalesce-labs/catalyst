// enrollment.mjs — execution-core enrollment reader (CTL-535 Phase 1).
//
// Reads the enrollment records CTL-554 writes to
// ~/catalyst/execution-core/projects/*.json, and resolves each enrolled
// project's eligibleQuery from its live <repoRoot>/.catalyst/config.json.
// CTL-535 is a pure CONSUMER of the enrollment contract — it never writes
// enrollment records (CTL-554 owns enrollment lifecycle).

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getEnrollmentDir, log } from "./config.mjs";

// listEnrolledProjects() — one record per *.json in the enrollment dir.
// The PRESENCE of a record file is the enrollment signal (CTL-554's --stop
// removes the file); the unpinned `status` field is NOT a filter (plan
// Design Decision #3).
export function listEnrolledProjects() {
  const dir = getEnrollmentDir();
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // enrollment dir does not exist yet — no projects enrolled
  }
  const projects = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = resolve(dir, name);
    let record;
    try {
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      log.warn({ file, err: err.message }, "skipping malformed enrollment record");
      continue;
    }
    if (!record?.projectKey || !record?.repoRoot) {
      log.warn({ file }, "skipping enrollment record missing projectKey or repoRoot");
      continue;
    }
    projects.push({
      projectKey: record.projectKey,
      repoRoot: record.repoRoot,
      enrolledAt: record.enrolledAt ?? null,
      status: record.status ?? null,
    });
  }
  return projects;
}

// loadProjectConfig(repoRoot) — resolve a project's eligibleQuery from its
// live .catalyst/config.json. Returns null (project skipped) when the repo
// config is missing/unreadable or carries no executionCore.eligibleQuery.
export function loadProjectConfig(repoRoot) {
  const configPath = resolve(repoRoot, ".catalyst", "config.json");
  let catalyst;
  try {
    catalyst = JSON.parse(readFileSync(configPath, "utf8"))?.catalyst;
  } catch {
    return null; // missing or unreadable repo config — skip this project
  }
  const eligibleQuery = catalyst?.orchestration?.executionCore?.eligibleQuery;
  if (!eligibleQuery) return null; // enrolled but unconfigured — skip
  return {
    team: eligibleQuery.team ?? catalyst?.linear?.teamKey ?? null,
    status: eligibleQuery.status ?? "Todo",
    project: eligibleQuery.project ?? null,
    label: eligibleQuery.label ?? null,
    priority: eligibleQuery.priority ?? null,
  };
}
