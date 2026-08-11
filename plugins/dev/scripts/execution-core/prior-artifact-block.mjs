// CAT-55: shared prior-artifact dispatch-block vocabulary and operator wording.
// Pure by design: scheduler, daemon, and orch-monitor can all import it.
export const PRIOR_ARTIFACT_MISSING_EXIT_CODE = 2;
export const PRIOR_ARTIFACT_MISSING_REASON = "prior_artifact_missing";
export const PRIOR_ARTIFACT_STALLED_REASON = "prior-artifact-retry-exhausted";

export function parseDispatchRefusal(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") return null;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let value;
    try { value = JSON.parse(text); } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (value.status !== "refused") continue;
    if (typeof value.reason !== "string" || value.reason.trim() === "") continue;
    const artifact = typeof value.artifact === "string" ? value.artifact : null;
    return {
      reason: value.reason,
      artifact,
      artifactDir: artifact ? artifact.replace(/^glob:|^signal:/, "") : null,
      searchedPath: typeof value.searchedPath === "string" && value.searchedPath ? value.searchedPath : null,
    };
  }
  return null;
}

export function isPriorArtifactBlock(signal) {
  return Boolean(signal && typeof signal === "object" &&
    signal.stalledReason === PRIOR_ARTIFACT_STALLED_REASON &&
    signal.dispatchFailureCode === PRIOR_ARTIFACT_MISSING_EXIT_CODE);
}

export function resolvePriorArtifactRespondGateMode(value = process.env.CATALYST_PRIOR_ARTIFACT_RESPOND_GATE) {
  return value === "off" || value === "shadow" || value === "enforce" ? value : "enforce";
}

export function priorArtifactPresence({ ticket, artifact, artifactDir, searchedPath, exists, list }) {
  if (!ticket || !searchedPath || typeof exists !== "function" || typeof list !== "function") return null;
  const spec = artifact ?? (artifactDir?.startsWith("thoughts/") ? `glob:${artifactDir}` : artifactDir ? `signal:${artifactDir}` : null);
  if (!spec) return null;
  if (spec.startsWith("signal:")) {
    try { return Boolean(exists(searchedPath)); } catch { return null; }
  }
  if (!spec.startsWith("glob:")) return null;
  let names;
  try {
    names = list(searchedPath);
  } catch (err) {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR" ? false : null;
  }
  if (!Array.isArray(names)) return null;
  const escaped = ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundarySafe = new RegExp(`-${escaped}(?:\\.md|-.*\\.md)$`, "i");
  return names.some((name) => typeof name === "string" && !name.startsWith(".") && boundarySafe.test(name));
}

export const PRIOR_ARTIFACT_FUTILE_RETRY_SENTENCE = (where) =>
  `Re-dispatching alone will not clear this: the gate re-checks ${where} and refuses again ` +
  `(exit ${PRIOR_ARTIFACT_MISSING_EXIT_CODE}) for as long as the document is absent. ` +
  "The document has to appear first.";

export function buildPriorArtifactExplanationFields({ ticket, phase, artifact, artifactDir, searchedPath }) {
  const where = searchedPath ?? artifactDir;
  const isGlob = artifact?.startsWith("glob:") ?? artifactDir?.startsWith("thoughts/");
  if (!isGlob) return null;
  return {
    escalation_type: "manual",
    problem: `${phase} cannot start for ${ticket}: no ${artifactDir} document for ${ticket} was found. Searched: ${where}`,
    call_to_action: `Put the ${ticket} ${artifactDir} document in ${where} (move it there if it was written under another thoughts profile, or re-run the prior phase to regenerate it), then re-dispatch ${ticket}/${phase}.`,
    blocked_capability: `locating the ${artifactDir} document for ${ticket}`,
    instructions: [
      "Check whether the document exists under a different thoughts profile.",
      `If it exists, move or copy it into ${where}.`,
      `If it does not exist, re-run the prior phase for ${ticket}.`,
      `Then re-dispatch ${ticket}/${phase}.`,
    ],
    remediation_then_retry: `Once the document is in ${where}, re-dispatch ${ticket}/${phase}.`,
    why_not_auto: PRIOR_ARTIFACT_FUTILE_RETRY_SENTENCE(where),
  };
}
