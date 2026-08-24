// executor-policy-budget.mjs — CTL-2116 Scenario 3. A COMMAND-TIME refusal:
// "may this policy change add Codex load right now?" CTL-1459 owns the separate
// DISPATCH-time question ("can we afford this dispatch"); nothing here touches
// the dispatch path.
//
// Three-valued by construction. `inconclusive` exists because a zero-account or
// all-unauthenticated read is "I could not look", not "there is headroom" — and
// the caller REFUSES on inconclusive (see cli/cluster-route.mjs), because the
// failure this gate exists to prevent (CTL-2046) is precisely a routing pin made
// while nobody could see the quota.
//
// Headroom is 100 - usedPercent of each account's BINDING window; a status-ok
// account with binding:null contributes nothing (deriveBindingWindow returns
// null rather than a fabricated 0, lib/codex-account-plane.mjs). A non-ok
// account (unauthenticated/rejected/error) is IGNORED, never counted as a
// phantom fresh (0% used) account — that would let one throttled account hide
// behind an unrelated one that was simply never logged in.
//
// No IO: `accounts` (a pre-read list) or `readAccounts` (a sync reader) are
// injected by the caller. cli/cluster-route.mjs supplies the real provider
// (discoverCodexHomes + readAccountPlane, the same pair
// codex-accounts-usage.mjs uses) so every test here runs with no `codex` binary.

export const DEFAULT_CODEX_BUDGET_FLOOR_PERCENT = 20;

function isCodexExec(raw) {
  return typeof raw === "string" && raw.trim().toLowerCase() === "codex-exec";
}

function codexPhases(routes) {
  const set = new Set();
  if (!routes || typeof routes !== "object") return set;
  for (const [phase, executor] of Object.entries(routes)) {
    if (isCodexExec(executor)) set.add(phase);
  }
  return set;
}

// addsCodexLoad — pure. True iff `nextRoutes` routes at least one phase to
// codex-exec that `priorRoutes` did not. A phase that stays codex-exec, or
// moves AWAY from it, never counts as new load.
export function addsCodexLoad({ priorRoutes, nextRoutes } = {}) {
  const prior = codexPhases(priorRoutes);
  const next = codexPhases(nextRoutes);
  for (const phase of next) {
    if (!prior.has(phase)) return true;
  }
  return false;
}

function buildFigure(account) {
  const binding = account?.binding;
  if (!binding || typeof binding.usedPercent !== "number") return null;
  return {
    handle: account.label ?? null,
    window: binding.label ?? "unknown",
    usedPercent: binding.usedPercent,
    headroomPercent: 100 - binding.usedPercent,
    resetsAt: binding.resetsAt ?? null,
  };
}

function buildRefusalMessage(figures, floorPercent) {
  const lines = [
    `no account has the ${floorPercent}% headroom reserved for Codex-routed work:`,
  ];
  for (const f of figures) {
    lines.push(
      `  ${f.handle}  ${f.window}  ${f.usedPercent}% used  ${f.headroomPercent}% headroom`,
    );
  }
  return lines.join("\n");
}

// classifyPolicyBudget — pure(ish) over injected accounts/readAccounts. Returns
// { verdict: "allow" | "refuse" | "inconclusive", headroomPercent?, figures?, message?, reason? }.
export function classifyPolicyBudget({
  addsCodexLoad: adds,
  floorPercent = DEFAULT_CODEX_BUDGET_FLOOR_PERCENT,
  accounts,
  readAccounts,
} = {}) {
  if (!adds) {
    return { verdict: "allow" };
  }

  let list = accounts;
  if (list === undefined) {
    if (typeof readAccounts !== "function") {
      return { verdict: "inconclusive", reason: "no-account-reader" };
    }
    try {
      list = readAccounts();
    } catch (err) {
      return { verdict: "inconclusive", reason: `account read threw: ${err?.message ?? err}` };
    }
  }

  if (!Array.isArray(list) || list.length === 0) {
    return { verdict: "inconclusive", reason: "no-accounts-discoverable" };
  }

  const figures = [];
  for (const account of list) {
    if (!account || account.status !== "ok") continue; // never a phantom 0% account
    const figure = buildFigure(account);
    if (figure) figures.push(figure);
  }

  if (figures.length === 0) {
    return { verdict: "inconclusive", reason: "no-usable-account-data" };
  }

  const headroomPercent = Math.max(...figures.map((f) => f.headroomPercent));
  if (headroomPercent >= floorPercent) {
    return { verdict: "allow", headroomPercent, figures };
  }
  return {
    verdict: "refuse",
    headroomPercent,
    figures,
    message: buildRefusalMessage(figures, floorPercent),
  };
}
