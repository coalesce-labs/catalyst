// sdk-session.mjs — CTL-1994. The one place that actually talks to the Claude
// Agent SDK. Everything else in this package is pure and testable; this file is
// the seam where that stops being true, so it is kept as thin as possible.
//
// It is deliberately NOT an import of execution-core's `sdk-run-phase-agent.mjs`:
// that module is worker-shaped (it needs an orchDir, a ticket, a phase and a
// signal file) and its import chain reaches `bun:sqlite` via config.mjs, so a
// role runner cannot load it under bare node. The DECISION logic both share
// lives in ../lib/agent-liveness.mjs — one copy, imported by both.
import { isOverloadedResult, isOverloadedError } from "../lib/agent-liveness.mjs";

/** Quota exhaustion is not an overload: it needs a long wait and a board line, not a retry ladder. */
function isQuotaExhausted(x) {
  const t = x?.error?.type ?? x?.type ?? "";
  if (t === "rate_limit_error" || t === "quota_exceeded") return true;
  return /quota|usage limit|insufficient credit/i.test(String(x?.message ?? x?.error?.message ?? ""));
}

/**
 * Build the options handed to query(). Subscription auth ONLY: the env always
 * deletes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, which outrank the OAuth
 * token in headless mode and silently meter.
 */
export function buildQueryOptions({ cwd, env, resumeSessionId, maxTurns = null }) {
  const clean = { ...env };
  delete clean.ANTHROPIC_API_KEY;
  delete clean.ANTHROPIC_AUTH_TOKEN;

  const options = {
    cwd,
    env: clean,
    // Unattended: skills self-gate via their frontmatter. A role that stops to
    // ask for a permission is a role that is down.
    permissionMode: "bypassPermissions",
  };
  if (maxTurns != null) options.maxTurns = maxTurns;
  if (resumeSessionId) options.resume = resumeSessionId;
  return options;
}

/**
 * Run one session to completion. Returns the shape `superviseRole` expects:
 * {exitCode, sessionId, overloaded, quotaExhausted, lastArtifact}.
 *
 * `query` is injectable so this file can be exercised without the SDK; the
 * default resolves `@anthropic-ai/claude-agent-sdk` lazily, so importing this
 * module never requires node_modules to be present.
 */
export async function runSdkSession({ prompt, cwd, env, resumeSessionId, maxTurns = null, query = null, log = console.log }) {
  let q = query;
  if (!q) {
    // Assembled rather than written as a literal, matching execution-core's
    // convention so a bundler does not try to resolve it at build time.
    const pkg = ["@anthropic-ai", "claude-agent-sdk"].join("/");
    ({ query: q } = await import(pkg));
  }

  const options = buildQueryOptions({ cwd, env, resumeSessionId, maxTurns });
  let sessionId = resumeSessionId ?? null;
  let lastArtifact = null;
  let result = null;

  try {
    for await (const message of q({ prompt, options })) {
      if (typeof message?.session_id === "string" && message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
        log(`role-supervisor: session ${sessionId}`);
      }
      // The last tool that wrote something is the "last artifact" the heartbeat
      // reports. A heartbeat that only proves the process exists cannot tell a
      // working role from a wedged one.
      const toolName = message?.tool_use?.name ?? message?.name;
      if (toolName && /write|edit|reply|create|update/i.test(String(toolName))) lastArtifact = String(toolName);
      if (message?.type === "result") result = message;
    }
  } catch (err) {
    if (isOverloadedError(err)) return { exitCode: 1, sessionId, overloaded: true, lastArtifact };
    if (isQuotaExhausted(err)) return { exitCode: 1, sessionId, quotaExhausted: true, lastArtifact };
    throw err;
  }

  if (isOverloadedResult(result)) return { exitCode: 1, sessionId, overloaded: true, lastArtifact };
  if (isQuotaExhausted(result)) return { exitCode: 1, sessionId, quotaExhausted: true, lastArtifact };

  // `error_max_turns` is a cap, not a failure: hand off and start fresh rather
  // than resuming a session that has already run out of room.
  if (result?.subtype === "error_max_turns") return { exitCode: 0, sessionId, lastArtifact, turnCapExhausted: true };

  const isError = result?.is_error === true || (result?.subtype && result.subtype !== "success");
  return { exitCode: isError ? 1 : 0, sessionId, lastArtifact };
}
