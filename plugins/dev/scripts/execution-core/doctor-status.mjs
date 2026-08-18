// doctor-status.mjs — the two primitives every doctor check is built from.
//
// Extracted so a check can live in its own module without importing doctor.mjs, which
// would be circular (doctor.mjs imports the checks). Zero imports, by design: this is
// the leaf both sides depend on. doctor.mjs re-exports both, so its public surface —
// and every existing `import { STATUS, mkCheck } from "./doctor.mjs"` — is unchanged.

export const STATUS = { PASS: "pass", WARN: "warn", FAIL: "fail", INFO: "info" };

export const mkCheck = (name, status, detail) => ({ name, status, detail });
