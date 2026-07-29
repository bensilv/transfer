import type { Direction, DirectionLabels } from './types';

export interface PickedDirectionLabels {
  /** The pair to put on the two-button toggle itself. */
  toggle: DirectionLabels;
  /**
   * The item's own label for `direction`, but only when it differs from the
   * toggle's word for that same side — null when they already agree, so
   * callers don't caption e.g. an "Uptown" chip with a redundant "Uptown".
   * Compares just the currently-viewed side (not the whole pair): an item
   * can share today's word with the toggle while its *other* direction
   * differs (a line sitting at its own terminal, say), and that shouldn't
   * caption anything the rider isn't currently looking at.
   */
  qualifierFor: (item: { directionLabels: DirectionLabels }, direction: Direction) => string | null;
}

const PLAIN_KEY = 'Uptown|Downtown';

function pairKey(pair: DirectionLabels): string {
  return `${pair.uptown}|${pair.downtown}`;
}

/**
 * Picks one direction-label pair to drive a single two-button toggle from a
 * set of items that each carry their own live-computed pair (one per line at
 * a station, or one per connecting line across a journey's transfers).
 *
 * Prefers the plain "Uptown"/"Downtown" pair when any item has it (the
 * recognizable default for ordinary trunk-line stations); otherwise falls
 * back to whichever pair the most items share. Items whose own label for the
 * currently-viewed direction differs from the toggle's word for that side
 * get flagged via `qualifierFor`, so the caller can show their real label
 * (e.g. "Canarsie-Rockaway Pkwy") instead of implying the toggle word
 * applies to them.
 */
export function pickDirectionLabels(items: { directionLabels: DirectionLabels }[]): PickedDirectionLabels {
  if (items.length === 0) {
    const toggle: DirectionLabels = { uptown: 'Uptown', downtown: 'Downtown' };
    return { toggle, qualifierFor: () => null };
  }

  const counts = new Map<string, { pair: DirectionLabels; count: number }>();
  for (const item of items) {
    const key = pairKey(item.directionLabels);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { pair: item.directionLabels, count: 1 });
  }

  let toggle = counts.get(PLAIN_KEY)?.pair;
  if (!toggle) {
    let best: { pair: DirectionLabels; count: number } | null = null;
    for (const entry of counts.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    toggle = best!.pair;
  }

  const resolvedToggle = toggle;
  return {
    toggle: resolvedToggle,
    qualifierFor: (item, direction) => {
      const own = item.directionLabels[direction];
      return own === resolvedToggle[direction] ? null : own;
    },
  };
}
