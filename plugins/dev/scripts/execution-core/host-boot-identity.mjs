// host-boot-identity.mjs — decide the effective coordination name at boot.
// Pure (no fs/env reads); callers pass resolved inputs. CTL-1093.

/**
 * Returns true when this host's coordination name comes from an explicit pin
 * (CATALYST_HOST_NAME env or Layer-2 catalyst.host.name) rather than os.hostname().
 */
export function isHostNamePinned({ env, layer2Name }) {
  return (typeof env === "string" && env.length > 0) ||
         (typeof layer2Name === "string" && layer2Name.length > 0);
}

/**
 * resolveBootIdentity — given the pinned flag, the name getHostName() resolved,
 * the recorded sticky name (or null), and whether the roster is multi-host,
 * return { name, action: "noop"|"record"|"restore", warning: string|null }.
 *
 * Single-host boots are a strict no-op — no warning, no state changes.
 */
export function resolveBootIdentity({ pinned, resolvedName, sticky, multiHost }) {
  if (!multiHost) return { name: resolvedName, action: "noop", warning: null };
  if (pinned) {
    return { name: resolvedName, action: "record", warning: null };
  }
  if (sticky) {
    return {
      name: sticky, action: "restore",
      warning: `host name is not pinned (no CATALYST_HOST_NAME, no ` +
        `catalyst.host.name) — restoring recorded sticky identity "${sticky}". ` +
        `Pin catalyst.host.name (Layer-2) to silence this and survive OS renames.`,
    };
  }
  return {
    name: resolvedName, action: "record",
    warning: `host name is not pinned and no sticky identity recorded — ` +
      `using os.hostname() "${resolvedName}", which changes under DHCP/DNS/Tailscale ` +
      `renames and will repartition HRW ownership. Pin catalyst.host.name (Layer-2).`,
  };
}
