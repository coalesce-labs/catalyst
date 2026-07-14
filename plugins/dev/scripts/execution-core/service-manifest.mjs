// service-manifest.mjs — CTL-1473: one per-class service manifest consumed by
// install-lifecycle.mjs and doctor.mjs.
// Encodes Ryan's decision: developer gets thoughts-sync, NOT the stack keep-alive.

export const LABELS = {
  stack: "ai.coalesce.catalyst-stack",
  updater: "ai.coalesce.catalyst-updater",
  thoughtsSync: "ai.coalesce.catalyst-thoughts-sync",
  shipper: "ai.coalesce.catalyst-log-shipper",
  orphanSweep: "ai.coalesce.catalyst-orphan-sweep",
  agent: "com.catalyst.agent",
  cloudSync: "ai.coalesce.catalyst-cloud-sync",
};

export const MANIFEST = {
  worker: {
    shipsLogs: true,
    required: [LABELS.stack, LABELS.thoughtsSync, LABELS.shipper, LABELS.orphanSweep, LABELS.agent],
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
