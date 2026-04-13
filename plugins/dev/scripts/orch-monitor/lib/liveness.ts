/**
 * Check whether a PID refers to a running process.
 *
 * Semantics:
 *  - ESRCH -> process does not exist -> false
 *  - EPERM -> process exists but we lack signal permission -> true
 *            (common for cross-UID or container-boundary cases)
 *  - Other errors -> logged, treated as not-alive
 */
export function checkProcessAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    console.error(`[liveness] process.kill(${pid}, 0) unexpected error:`, err);
    return false;
  }
}
