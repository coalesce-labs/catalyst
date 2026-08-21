// CTL-1573 P1 — declarations for the trusted-origin allowlist.
// Keep in sync with trusted-origin.mjs (a declaration/runtime drift is itself
// one of the CTL-1573 findings — see inbox-ask.d.mts).

export declare function originHost(origin: unknown): string | null;

export declare function selfAddresses(): string[];

export declare function bonjourName(): string | null;

export declare function _resetBonjourCache(): void;

export declare function _bonjourResolveCount(): number;

export declare function _bonjourTtlMs(): number;

export declare function tailscaleMagicDnsName(): string | null;

export declare function _resetTailscaleCache(): void;

export declare function _tailscaleResolveCount(): number;

export declare function buildTrustedOrigins(opts?: {
  port?: number;
  extraOrigins?: string[] | string | null;
  hostnames?: string[];
  addresses?: string[];
  devOrigins?: string[] | string | null;
  bindHost?: string | null;
  tailscaleDnsName?: string | null;
}): Set<string>;

export declare function isOriginAllowed(
  origin: string | null | undefined,
  trusted: Set<string>,
): boolean;
