// Type declarations for cluster-claim.mjs — CTL-865.
export interface ClaimMetadata {
  owner_host: string | null;
  generation: number | null;
  phase: string | null;
  claimed_at: string | null;
}

export declare function readClaim(ticket: string, opts?: { post?: unknown }): Promise<ClaimMetadata | null>;
