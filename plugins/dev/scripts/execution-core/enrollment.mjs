// enrollment.mjs — execution-core enrollment reader + writer.
//
// CTL-535 Phase 1 added the READER half: listEnrolledProjects() globs
// ~/catalyst/execution-core/projects/*.json and loadProjectConfig() resolves
// each enrolled project's eligibleQuery from its live
// <repoRoot>/.catalyst/config.json.
//
// CTL-554 adds the WRITER half: writeEnrollmentRecord()/removeEnrollmentRecord()
// own the enrollment lifecycle that /orchestrate drives in execution-core
// dispatchMode. Records written here are read back verbatim by
// listEnrolledProjects() — the two halves share isSafePathSegment().

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { getEnrollmentDir, log } from "./config.mjs";

// A projectKey is used verbatim as a filesystem path segment for the
// eligible-set projection (eligible/<projectKey>.json). Reject anything that
// is not a single safe path component so a malformed enrollment record can
// never traverse out of the eligible/ directory (e.g. projectKey "../foo").
function isSafePathSegment(key) {
  return /^[A-Za-z0-9._-]+$/.test(key) && key !== "." && key !== "..";
}

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
    if (!isSafePathSegment(record.projectKey)) {
      log.warn(
        { file, projectKey: record.projectKey },
        "skipping enrollment record with unsafe projectKey (not a valid path segment)"
      );
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

// writeEnrollmentRecord — enroll a project (CTL-554). Writes
// ~/catalyst/execution-core/projects/<projectKey>.json atomically (tmp +
// renameSync, mirroring eligible-set.mjs) so listEnrolledProjects() never
// observes a torn write. The `status` field is stamped "active" for operator
// observability only; the reader still treats file presence as the enrollment
// signal and never filters on status. Re-enrolling overwrites in place.
export function writeEnrollmentRecord({ projectKey, repoRoot, enrolledAt, status } = {}) {
  if (!projectKey || !repoRoot) {
    throw new Error("writeEnrollmentRecord: projectKey and repoRoot are required");
  }
  if (!isSafePathSegment(projectKey)) {
    throw new Error(`writeEnrollmentRecord: unsafe projectKey '${projectKey}'`);
  }
  const dir = getEnrollmentDir();
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${projectKey}.json`);
  const record = {
    projectKey,
    repoRoot,
    enrolledAt: enrolledAt ?? new Date().toISOString(),
    status: status ?? "active",
  };
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp already gone */
    }
    throw err;
  }
  return record;
}

// removeEnrollmentRecord — deregister a project (CTL-554's /orchestrate
// --stop). Deleting the record file is the unenrollment signal; the daemon
// drops the project on its next reconcile. A no-op when the record is already
// absent, so --stop is idempotent.
export function removeEnrollmentRecord(projectKey) {
  if (!projectKey || !isSafePathSegment(projectKey)) {
    throw new Error(`removeEnrollmentRecord: unsafe projectKey '${projectKey}'`);
  }
  const file = resolve(getEnrollmentDir(), `${projectKey}.json`);
  try {
    rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}
