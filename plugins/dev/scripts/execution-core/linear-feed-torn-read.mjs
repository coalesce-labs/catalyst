/**
 * CTL-1920 — telling a torn replica read apart from a real change set.
 *
 * ## The incident this exists for
 *
 * A `launchctl kickstart` of the cloud-sync writer on mini-2 (2026-08-17) produced
 * **400 `linear.issue.updated` edges in one minute**, against an organic rate of 1–3.
 * All 400 carried `feedAuthority: true`, so under `enforce` they were routed through
 * the real dispatch handlers — measured, not inferred.
 *
 * The mechanism is a torn cross-table read, and every step of it is working as
 * written:
 *
 *   1. A column-adding migration makes the SDK force ONE `/snapshot` re-seed.
 *      `seedFromSnapshot` TRUNCATES every entity table in one transaction, then
 *      repopulates in 1000-row batches — **one transaction per batch**. The SDK's own
 *      comment says this preserves the writer's crash-safety "without holding one
 *      giant transaction". That is writer recovery. It is **not reader isolation**.
 *   2. The label sweep reads `issue_labels JOIN labels` and `issues` as two separate
 *      queries at two separate instants, and it has no cursor to keyset on. A tick
 *      landing after `issues` is restored but before the label rows are sees an
 *      issue as **absent from the label map**.
 *   3. Absence there legitimately means "every label removed" — that branch exists so
 *      that clearing an issue's last label is detectable at all. So the sweep emits.
 *   4. The baseline lives in a SEPARATE database the re-seed never touches. That
 *      asymmetry — baseline survives, replica is wiped — is what makes the burst
 *      constructible in the first place.
 *
 * ## Why this is a magnitude question and not a plumbing question
 *
 * The feed is **structurally blind** to a re-seed: `feed-progress.json` publishes
 * eight fields and not one of them is a seed/generation marker (its `pid` has zero
 * readers). So there is no flag to check. Measured across the whole feed path, there
 * is also **no magnitude guard of any kind** — every numeric bound is a pagination
 * budget or a staleness timer, and `counts.emitted` is incremented at three sites and
 * read for comparison at none. Once seeded, a 4,000-row diff emits 4,000 edges with
 * no objection.
 *
 * Guarding on magnitude rather than on a re-seed flag is the deliberate choice: it
 * needs no cooperation from the writer, survives a version skew where the writer
 * predates the feed, and catches **any** cause of mass divergence — a future truncate
 * path, a restore, a corrupted replica — not just the one incident we happened to
 * measure.
 *
 * ## ⚠️ The trap: a guard that cannot be overruled is a wedge
 *
 * A genuine mass label removal — deleting a label from the workspace — looks exactly
 * like a torn read on the tick it happens. A guard that simply refused would refuse
 * again next tick, and forever: the divergence never shrinks on its own, so the feed
 * would go permanently silent on a real change. That is a worse failure than the
 * burst.
 *
 * The discriminator is **persistence, not shape**. A torn read is transient by
 * construction — the writer finishes its batches in seconds and the map comes back.
 * A genuine removal persists. So a suspected tear is skipped for at most
 * `sustainedTicks` consecutive ticks and then ACCEPTED as real. Same
 * `sustainedTicks` discipline as CTL-1502's daemon watchdog and CTL-1659's dep-skew
 * classifier, for the same reason: never let a detector take an irreversible action
 * on one sample, and never let it hold an action forever.
 *
 * ## Why SKIP rather than re-snapshot
 *
 * The first-seed precedent (`seedBaseline`) re-snapshots silently, which is right
 * when there is nothing to miss. Here there is: re-snapshotting from a torn replica
 * would bake the torn state INTO the baseline — the exact corruption that doubles the
 * burst today, since the emit path writes the empty label set back and the restore
 * then diffs those same issues a second time. Skipping leaves the baseline untouched,
 * so once the replica is whole the very next sweep diffs against real prior truth and
 * emits precisely the genuine changes. **Skipping loses nothing; re-snapshotting
 * would.**
 */

/** More than half the baselined-labelled corpus vanishing at once is not user activity. */
export const DEFAULT_TORN_VANISH_RATIO = 0.5;

/**
 * An absolute floor, so a tenant with three labelled issues cannot trip the ratio by
 * closing one. Below this the burst is not worth a false silence.
 */
export const DEFAULT_TORN_VANISH_FLOOR = 25;

/**
 * ~90 s at the default 30 s tick — comfortably longer than the observed re-seed, and
 * a bounded delay (not a loss) for a genuine mass edit, which is emitted in full once
 * the count is reached.
 */
export const DEFAULT_TORN_SUSTAINED_TICKS = 3;

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * Classify one tick's label-map divergence.
 *
 * Pure: no clock, no I/O, no module state. The caller owns the consecutive counter so
 * that the decision is reproducible from its inputs alone.
 *
 * @param {object} args
 * @param {number} args.vanished              issues baselined WITH labels that are absent from the current map
 * @param {number} args.baselinedWithLabels   size of the baselined-labelled corpus
 * @param {number} args.consecutiveTorn       consecutive prior ticks already classified torn (0 on the first)
 * @param {number} [args.ratio]
 * @param {number} [args.floor]
 * @param {number} [args.sustainedTicks]
 * @returns {{torn: boolean, accept: boolean, reason: string|null, nextConsecutive: number}}
 *   `torn`   — this tick's divergence has the shape of a torn read.
 *   `accept` — proceed to emit anyway (either not torn, or torn for long enough to be real).
 *   ⚠️ `torn && accept` is a REAL state, not a contradiction: it is the overrule.
 */
export function classifyLabelMapTear({
  vanished,
  baselinedWithLabels,
  consecutiveTorn = 0,
  ratio = DEFAULT_TORN_VANISH_RATIO,
  floor = DEFAULT_TORN_VANISH_FLOOR,
  sustainedTicks = DEFAULT_TORN_SUSTAINED_TICKS,
} = {}) {
  // ⚠️ Fail OPEN (accept, emit) on malformed input rather than closed. A guard that
  // silences the feed on input it cannot parse would convert a counting bug into a
  // dispatch outage — strictly worse than the burst it is here to prevent. The
  // degradation is NAMED so it cannot be read as a clean tick.
  if (!isNonNegInt(vanished) || !isNonNegInt(baselinedWithLabels)) {
    return { torn: false, accept: true, reason: "torn-check-uncomputable", nextConsecutive: 0 };
  }
  if (!isNonNegInt(consecutiveTorn)) consecutiveTorn = 0;

  const effFloor = isNonNegInt(floor) ? floor : DEFAULT_TORN_VANISH_FLOOR;
  const effRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_TORN_VANISH_RATIO;
  const effSustained =
    Number.isInteger(sustainedTicks) && sustainedTicks > 0 ? sustainedTicks : DEFAULT_TORN_SUSTAINED_TICKS;

  // Nothing vanished ⇒ nothing to suspect, whatever the corpus size.
  if (vanished === 0) return { torn: false, accept: true, reason: null, nextConsecutive: 0 };

  const overFloor = vanished >= effFloor;
  const overRatio = baselinedWithLabels > 0 && vanished >= effRatio * baselinedWithLabels;
  const torn = overFloor && overRatio;

  if (!torn) return { torn: false, accept: true, reason: null, nextConsecutive: 0 };

  const nextConsecutive = consecutiveTorn + 1;
  // Held for `effSustained` ticks, then overruled. `>` (not `>=`) so that
  // sustainedTicks=3 skips exactly 3 ticks and emits on the 4th.
  if (nextConsecutive > effSustained) {
    return {
      torn: true,
      accept: true,
      reason: `torn-overruled-sustained:${nextConsecutive}`,
      nextConsecutive,
    };
  }
  return {
    torn: true,
    accept: false,
    reason: `replica-torn-read:vanished=${vanished}/${baselinedWithLabels}:tick=${nextConsecutive}`,
    nextConsecutive,
  };
}

/**
 * Per-tenant consecutive-tear counter.
 *
 * In-memory and per-process on purpose. A daemon restart resets it to 0, which can
 * only ever ADD up to `sustainedTicks` of extra caution — it can never cause an
 * emission that would otherwise have been held. Persisting it would buy nothing and
 * would introduce a durable file whose own corruption the guard would then have to
 * survive (CTL-1659's ledger lesson).
 */
export function createTearTracker() {
  const byKey = new Map();
  return {
    get(key) {
      return byKey.get(key) ?? 0;
    },
    set(key, value) {
      if (isNonNegInt(value) && value > 0) byKey.set(key, value);
      else byKey.delete(key);
    },
    size() {
      return byKey.size;
    },
  };
}
