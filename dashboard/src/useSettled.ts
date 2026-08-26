import { useEffect, useRef, useState } from 'react';

/**
 * The settle both counting surfaces use — the gate board's live panel and the
 * pallet printing card. ONE definition on purpose: the same pallet must not
 * settle at two different rhythms depending on which screen you look at.
 *
 *   600ms quiet — comfortably longer than the ~270ms measured between cartons,
 *     so a pallet arrives as ONE number, and short enough that the figure still
 *     lands within a beat of the last carton going through.
 *   2.5s ceiling — a long unload never goes quiet, so it publishes on this
 *     instead: a few readable jumps rather than a figure that sits stale for two
 *     minutes.
 *
 * Raise the quiet window if pallets still arrive split across two jumps; lower
 * it if the figure feels late. Nothing is held back but the drawing of it — no
 * carton, no print, no delivery waits on these.
 */
export const COUNT_SETTLE = { quietMs: 600, maxHoldMs: 2_500 };

/**
 * Show a figure that JUMPS to its new value instead of ticking up to it.
 *
 * THE PROBLEM THIS EXISTS FOR. Cartons do not arrive together. Measured on the
 * live gate (2026-08-25, no-IR mode), a pallet lands one carton every ~270ms —
 * 11 cartons over 2.8s, 108 over two minutes. Every one of those is a separate
 * movement, so a panel that renders each as it arrives spends three seconds
 * counting 1, 2, 3 … 11 in front of the operator. The number is never wrong; it
 * is just never FINISHED, and a figure still moving reads as a gate still
 * thinking. Nobody can act on it until it stops.
 *
 * So the display holds still while cartons are flowing and publishes the whole
 * group at once. Two timers, the same pair the gate's own passage layer uses:
 *
 *   quietMs   — publish this long after the last change. The pallet settles,
 *               the number appears in ONE step.
 *   maxHoldMs — publish anyway after this long, even mid-flow. Without it a
 *               continuous two-minute unload would sit on a stale figure for
 *               the whole unload, which is the same complaint from the other
 *               end. Long bursts land in a few big jumps instead of hundreds of
 *               tiny ones.
 *
 * What this does NOT do is make cartons arrive sooner: the last carton still
 * shows up quietMs after it is read. It trades a small, fixed delay for a
 * figure that is readable the moment it appears.
 *
 * Two changes bypass the hold entirely, because both are cases where showing
 * the OLD value is worse than showing a moving one:
 *   - the first value (mount), so a reloaded panel paints immediately;
 *   - any change the caller marks as a RESET (see `immediate`), e.g. the board
 *     being cleared or a pallet expiring — a figure that has been withdrawn must
 *     never linger.
 */

/**
 * How long to wait before publishing, given when the current hold began.
 * 0 means "publish now — the ceiling is up".
 *
 * Pulled out of the hook because it is the whole behaviour and the only part
 * that can be got wrong quietly: a ceiling measured from the wrong instant
 * either never fires (a figure frozen for a whole unload) or fires on every
 * carton (the ticking this exists to stop). Exported so it can be checked
 * without a DOM.
 */
export function settleDelayMs(holdStartedAt: number, now: number, quietMs: number, maxHoldMs: number): number {
  // Measured from the START of the hold, not from this change, so a burst that
  // never goes quiet still publishes on schedule.
  const untilCeiling = holdStartedAt + maxHoldMs - now;
  if (untilCeiling <= 0) return 0;
  return Math.min(quietMs, untilCeiling);
}

export function useSettled<T>(
  value: T,
  opts: { quietMs: number; maxHoldMs: number; immediate?: (next: T, shown: T) => boolean }
): T {
  const { quietMs, maxHoldMs, immediate } = opts;
  const [shown, setShown] = useState(value);
  // The value waiting to be published, and when the current hold began. Refs,
  // not state: they change on every carton and must not themselves re-render.
  const latest = useRef(value);
  const holdStartedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the effect so a caller passing an inline arrow doesn't restart
  // the hold on every render.
  const immediateRef = useRef(immediate);
  immediateRef.current = immediate;

  useEffect(() => {
    latest.current = value;
    if (Object.is(value, shown)) return;

    const publish = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      holdStartedAt.current = null;
      setShown(latest.current);
    };

    if (immediateRef.current?.(value, shown)) return publish();

    const now = Date.now();
    if (holdStartedAt.current == null) holdStartedAt.current = now;
    const delay = settleDelayMs(holdStartedAt.current, now, quietMs, maxHoldMs);
    if (delay === 0) return publish();

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(publish, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [value, shown, quietMs, maxHoldMs]);

  return shown;
}
