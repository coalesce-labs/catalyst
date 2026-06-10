// cluster-types-drift.test.ts — CI drift guard verifying that the UI's mirrored
// ClusterBoardPayload type stays structurally aligned with the server's type.
// Uses a compile-time fixture that must satisfy both import type declarations.
import { test, expect } from "bun:test";
import type { ClusterBoardPayload as ServerPayload } from "../lib/cluster-data";
import type { ClusterBoardPayload as UiPayload } from "../ui/src/board/types";

// Structural assignment check: a value that satisfies UiPayload must also satisfy
// ServerPayload and vice versa. If the key sets diverge, tsc fails.
type _UiExtendsServer = UiPayload extends ServerPayload ? true : false;
type _ServerExtendsUi = ServerPayload extends UiPayload ? true : false;

const _checkUi: _UiExtendsServer = true;
const _checkServer: _ServerExtendsUi = true;

test("cluster type drift guard — UI ClusterBoardPayload satisfies server type", () => {
  // Types asserted at compile time above; runtime just confirms the test ran.
  expect(_checkUi).toBe(true);
  expect(_checkServer).toBe(true);
});
