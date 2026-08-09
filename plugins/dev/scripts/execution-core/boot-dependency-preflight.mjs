// boot-dependency-preflight.mjs — CAT-29. Best-effort boot probe for the tools
// required to see Linear and launch workers. A definitive miss quarantines the
// daemon; an indeterminate probe failure remains fail-open.
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { emitBootDependencyUnusable } from "./dispatch-alert.mjs";

export const BOOT_DEPENDENCY_HOLD_REASON = "board-dependency-unresolved";

export function defaultResolveInPath(tool, env = process.env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, tool), constants.X_OK);
      return join(dir, tool);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "EACCES") throw err;
    }
  }
  return null;
}

export function resolveBootDependencies({
  env = process.env,
  tools = ["linearis", "node"],
  resolveInPath = defaultResolveInPath,
  emit = emitBootDependencyUnusable,
  log,
} = {}) {
  try {
    const missing = tools.filter((tool) => !resolveInPath(tool, env));
    if (missing.length === 0) return { ok: true, missing: [], holdReason: null };
    try {
      emit({ missing, pathStr: env.PATH ?? "", reason: `required boot tools are not executable: ${missing.join(", ")}` });
    } catch (err) {
      log?.warn?.({ err: err?.message }, "boot dependency alert failed");
    }
    return { ok: false, missing, holdReason: BOOT_DEPENDENCY_HOLD_REASON };
  } catch (err) {
    log?.warn?.({ err: err?.message }, "boot dependency probe indeterminate");
    return { ok: true, missing: [], degraded: true, holdReason: null };
  }
}
