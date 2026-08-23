// autotune-setpoint.mjs — CTL-770's setpoint resolver, extracted (CTL-1214).
//
// ⛔ ZERO-IMPORT LEAF, and that is the whole reason this file exists. The
// resolver lived in `execution-core/scheduler.mjs`, which reaches `bun:sqlite`
// and therefore CANNOT be loaded by `catalyst doctor` — doctor runs under BARE
// NODE (measured: `import("./execution-core/scheduler.mjs")` under node v24
// rejects with "Only URLs with a scheme in: file, data, and node are supported
// … Received protocol 'bun:'"). Without the extraction, doctor's
// `autotune-setpoint-present` arm would have had to re-type the ladder, and a
// second copy of a 4-line precedence rule is exactly how a grade silently stops
// matching the behavior it grades. `scheduler.mjs` re-exports this symbol, so
// every existing importer is unchanged.
//
// Same discipline as `lib/event-name.mjs` and `lib/secret-contract.mjs`: one
// definition, kept reachable from the bare-Node runtime by having no imports at
// all — do not add any.

/**
 * resolveTargetSetpoint — CTL-770: resolve the autotuner's seek-to TARGET with
 * host-over-repo layering. The HOST Layer-2 file may carry
 * `catalyst.orchestration.executionCore.targetParallel` (distinct from
 * `maxParallel`, which the autotuner clobbers every tick as its live runtime
 * mirror — reusing it for the target would be overwritten). When the host key is
 * a positive integer it wins; otherwise fall back to Layer-1's committed
 * `maxParallel`. Returns `undefined` when neither is set → the caller's
 * convergence branches no-op (backward-compatible). The positive-int guard
 * mirrors mergeExecutionCoreConcurrency so a malformed host value never zeroes
 * the setpoint. The caller is responsible for core-bounding the result.
 *
 * @param {{maxParallel?: unknown}} [layer1]
 * @param {{targetParallel?: unknown}} [layer2]
 * @returns {number|undefined}
 */
export function resolveTargetSetpoint(layer1 = {}, layer2 = {}) {
  const t = layer2?.targetParallel;
  if (Number.isInteger(t) && t > 0) return t;
  return layer1?.maxParallel;
}
