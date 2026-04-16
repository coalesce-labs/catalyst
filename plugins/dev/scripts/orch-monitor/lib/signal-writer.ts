import { readFileSync, writeFileSync, renameSync } from "fs";

/**
 * Atomically write merged-PR status back to a worker signal file.
 *
 * Called by orch-monitor when it observes a PR as MERGED via gh polling
 * but the signal file on disk has not yet been updated — e.g. the
 * orchestrator LLM agent exited before its Phase 4 loop saw the merge.
 *
 * Idempotent: returns false without writing if the file already reports
 * status=done with pr.ciStatus=merged and the same mergedAt.
 */
export function writeMergedSignalFile(
  signalPath: string,
  mergedAt: string | null,
): boolean {
  let raw: string;
  try {
    raw = readFileSync(signalPath, "utf8");
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return false;
    console.error(
      `[signal-writer] read failed for ${signalPath}:`,
      errno.message,
    );
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[signal-writer] parse failed for ${signalPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const signal = parsed as Record<string, unknown>;

  const existingPr =
    typeof signal.pr === "object" && signal.pr !== null && !Array.isArray(signal.pr)
      ? (signal.pr as Record<string, unknown>)
      : {};

  const existingMergedAt =
    typeof existingPr.mergedAt === "string" ? existingPr.mergedAt : null;
  if (
    signal.status === "done" &&
    existingPr.ciStatus === "merged" &&
    existingMergedAt === mergedAt
  ) {
    return false;
  }

  const nowIso = new Date().toISOString();
  const nextPr: Record<string, unknown> = {
    ...existingPr,
    ciStatus: "merged",
  };
  if (mergedAt) nextPr.mergedAt = mergedAt;

  const phaseTimestamps =
    typeof signal.phaseTimestamps === "object" &&
    signal.phaseTimestamps !== null &&
    !Array.isArray(signal.phaseTimestamps)
      ? { ...(signal.phaseTimestamps as Record<string, unknown>) }
      : {};
  phaseTimestamps.done = nowIso;

  const existingCompletedAt =
    typeof signal.completedAt === "string" && signal.completedAt.length > 0
      ? signal.completedAt
      : null;
  const completedAt = mergedAt ?? existingCompletedAt ?? nowIso;

  const next: Record<string, unknown> = {
    ...signal,
    status: "done",
    phase: 6,
    updatedAt: nowIso,
    pr: nextPr,
    phaseTimestamps,
    completedAt,
  };

  const tmpPath = `${signalPath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmpPath, signalPath);
    return true;
  } catch (err) {
    console.error(
      `[signal-writer] write failed for ${signalPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
