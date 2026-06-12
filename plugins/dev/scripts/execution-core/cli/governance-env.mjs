// cli/governance-env.mjs — CTL-1084. Emits `export CATALYST_*=...` lines for the
// four beliefs-family flags resolved from the durable three-layer config, so the
// launcher can inject the durable value into the daemon's env (no env-export
// ritual). READ-ONLY; the per-tick gates keep reading process.env unchanged.
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

if (import.meta.main) main();
