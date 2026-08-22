// service-manifest.mjs — CTL-1473: per-class service manifest.
// Encodes Ryan's decision: developer gets thoughts-sync, NOT the stack keep-alive.
//
// CONSUMPTION (kept honest — CTL-1473 remediate): today only `shipsLogs()` and
// `LABELS` are imported in production, by doctor.mjs (log-shipper + label
// resolution). install-lifecycle.mjs does NOT import this module — planPhases
// hardcodes its adopt-updater / adopt-thoughts-sync steps — so `agentsForClass()`,
// `MANIFEST.required`, `MANIFEST.forbidden`, and `installVia` have NO production
// consumer yet: they are a DECLARATIVE spec of the intended per-class agent set,
// not an enforced invariant. Treat them as `@internal`/aspirational until a
// caller (planPhases and/or a doctor agent-set check) is wired to them; do not
// assume the required/forbidden lists are validated anywhere at runtime.

export const LABELS = {
  stack: "ai.coalesce.catalyst-stack",
  updater: "ai.coalesce.catalyst-updater",
  thoughtsSync: "ai.coalesce.catalyst-thoughts-sync",
  shipper: "ai.coalesce.catalyst-log-shipper",
  orphanSweep: "ai.coalesce.catalyst-orphan-sweep",
  agent: "com.catalyst.agent",
  cloudSync: "ai.coalesce.catalyst-cloud-sync",
  // CTL-2145: the account-rotation actor's LaunchAgent. DOCUMENTATION-LEVEL, like every
  // other entry in MANIFEST.required (see the header): nothing enforces this list at
  // runtime. The agent is actually installed by the `install-services` delegate to
  // install-account-rotation.sh, which applies its own node-class + claude-accounts.env
  // gate — so a worker host with no accounts provisioned correctly ends up WITHOUT it
  // even though it is listed as required here. Declaring it still buys the doctor-facing
  // label resolution and states the intent in one place.
  accountRotation: "ai.coalesce.catalyst-account-rotation",
};

export const MANIFEST = {
  worker: {
    shipsLogs: true,
    required: [
      LABELS.stack,
      LABELS.thoughtsSync,
      LABELS.shipper,
      LABELS.orphanSweep,
      LABELS.agent,
      LABELS.accountRotation,
    ],
    forbidden: [LABELS.updater],
    installVia: "install-services",
  },
  developer: {
    shipsLogs: false,
    required: [LABELS.updater, LABELS.thoughtsSync],
    forbidden: [LABELS.stack, LABELS.shipper],
    installVia: "adopt-updater+adopt-thoughts-sync",
  },
  monitor: null,
};
MANIFEST.monitor = MANIFEST.developer;

export function agentsForClass(cls) {
  return (MANIFEST[cls] ?? MANIFEST.developer).required;
}

export function shipsLogs(cls) {
  return (MANIFEST[cls] ?? MANIFEST.developer).shipsLogs;
}
