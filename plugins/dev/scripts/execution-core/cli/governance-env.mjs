// cli/governance-env.mjs — CTL-1084. Emits `export CATALYST_*=...` lines for the
// four beliefs-family flags resolved from the durable three-layer config, so the
// launcher can inject the durable value into the daemon's env (no env-export
// ritual). READ-ONLY; the per-tick gates keep reading process.env unchanged.
import { fileURLToPath } from "node:url";
import { readGovernanceConfig } from "../config.mjs";

const FLAG_ENV = {
  beliefsShadow:        "CATALYST_BELIEFS_SHADOW",
  diagnostician:        "CATALYST_DIAGNOSTICIAN",
  intentsEnforce:       "CATALYST_INTENTS_ENFORCE",
  advanceShadowSummary: "CATALYST_ADVANCE_SHADOW_SUMMARY",
};

export function buildGovernanceExports({ env = process.env, governance } = {}) {
  const g = governance ?? readGovernanceConfig(env);
  return Object.entries(FLAG_ENV)
    .map(([key, name]) => `export ${name}="${g[key] ? "1" : "0"}"`)
    .join("\n");
}

export function main() {
  process.stdout.write(buildGovernanceExports() + "\n");
}

// CTL-578: portable entrypoint detection. `import.meta.main` is native to Bun
// and Node ≥22.16; older Node treats it as undefined, which under a bare
// `if (import.meta.main)` gate makes `node governance-env.mjs` a silent no-op —
// the launcher would then eval empty output and the durable governance flags
// would never reach the daemon env. Fall back to comparing the module URL
// against argv[1] so this CLI fires under any runtime.
const isEntry =
  import.meta.main === true ||
  (typeof import.meta.url === "string" &&
    process.argv[1] &&
    fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) main();
