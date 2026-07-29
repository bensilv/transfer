import type { Station } from './stations.js';
import type { Direction } from '../realtime/types.js';

const BOROUGH_NAME: Record<string, string> = {
  M: 'Manhattan',
  Bk: 'Brooklyn',
  Bx: 'The Bronx',
  Q: 'Queens',
  SI: 'Staten Island',
};

// Above this dominant-axis ratio, a hop counts as "vertical" (running along
// the Manhattan/Bronx uptown-downtown axis) rather than crosstown. Tuned so
// ordinary trunk-line hops (nearly due north/south) clear it comfortably
// while genuinely crosstown hops (L, 7, G, JZ — nearly due east/west) don't.
const VERTICAL_DOMINANCE_RATIO = 1.2;

/** Rough local-plane offset in km, accurate enough for adjacent-stop distances. */
function localOffsetKm(from: Station, to: Station): { dx: number; dy: number } {
  const latRad = (from.lat * Math.PI) / 180;
  const dy = (to.lat - from.lat) * 110.57;
  const dx = (to.lon - from.lon) * 111.32 * Math.cos(latRad);
  return { dx, dy };
}

/**
 * Human-facing label for a specific trip's remaining travel, computed live
 * off the real-time feed rather than a per-line lookup table:
 *
 * - `bearingStop` is that trip's very next stop after `from` — its position
 *   relative to `from` decides whether this hop is "vertical" (uptown/
 *   downtown) or crosstown, since a train's local heading is a much more
 *   reliable signal than a straight line to its eventual terminal (the L
 *   ends up southeast of Union Sq, but it leaves Union Sq heading due east).
 * - `terminal` is that trip's actual final stop this decode — supplies the
 *   place name, and reflects reroutes/short-turns automatically since it's
 *   read straight off today's feed, not a schedule.
 *
 * Both inputs come from the live GTFS-RT decode, so nothing here is
 * per-line or per-route special-cased.
 */
export function directionLabel(
  from: Station,
  bearingStop: Station | null,
  terminal: Station | null,
  direction: Direction,
): string {
  const fallback = direction === 'uptown' ? 'Uptown' : 'Downtown';
  if (!bearingStop || !terminal) return fallback;

  const { dx, dy } = localOffsetKm(from, bearingStop);
  const fromIsVerticalAxis = from.borough === 'M' || from.borough === 'Bx';
  const isVerticalHop = Math.abs(dy) > Math.abs(dx) * VERTICAL_DOMINANCE_RATIO;

  if (fromIsVerticalAxis && isVerticalHop) {
    const base = dy >= 0 ? 'Uptown' : 'Downtown';
    if (terminal.borough !== from.borough && terminal.borough !== 'M') {
      return `${base} & ${BOROUGH_NAME[terminal.borough] ?? terminal.borough}`;
    }
    return base;
  }

  if (terminal.borough === 'M' && from.borough !== 'M') return 'Manhattan';
  return terminal.name;
}
