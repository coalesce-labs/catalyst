// put-project.ts — client helper for PUT /api/projects/:key (CTL-1153 Phase 5).
// Thin fetch wrapper; all error handling is left to the caller.

export interface ProjectPatch {
  name?: string | null;
  color?: string | null;
  icon?: string | null;
  stateMap?: Record<string, string> | null;
}

/**
 * Persist a project patch to the server. Throws if the server responds with a
 * non-2xx status (wraps the status + body in the error message).
 */
export async function putProject(key: string, patch: ProjectPatch): Promise<void> {
  const r = await fetch(`/api/projects/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    let detail = "";
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`PUT /api/projects/${key} failed: ${r.status} ${detail}`.trim());
  }
}
