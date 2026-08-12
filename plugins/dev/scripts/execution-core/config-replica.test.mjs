import { describe, expect, test } from "bun:test";
import { readReplicaBoardHealthConfig, readReplicaReseedConfig } from "./config.mjs";

describe("replica mode config", () => {
  for (const [name, read, key] of [["board health", readReplicaBoardHealthConfig, "CATALYST_BH_REPLICA"], ["reseed", readReplicaReseedConfig, "CATALYST_REPLICA_RESEED"]]) {
    test(`${name}: valid env wins and invalid env fails safe to shadow`, () => {
      expect(read({ [key]: "enforce" }).mode).toBe("enforce");
      expect(read({ [key]: "off" }).mode).toBe("off");
      expect(read({ [key]: "enfore" }).mode).toBe("shadow");
    });
  }
});
