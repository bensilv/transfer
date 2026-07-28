import { Direction } from '../realtime/types.js';

/**
 * Ordered station sequence for each line + direction, restricted to the five
 * seeded stations (see stations.ts). This stands in for what would normally
 * come from static GTFS `stop_times.txt`/`trips.txt` shape sequencing.
 * Directions follow real MTA convention (downtown ~ southbound, uptown ~
 * northbound), except the L which has no north/south leg — "downtown" is
 * used for westbound (toward 8 Av) and "uptown" for eastbound, to stay
 * consistent with the single home-screen Uptown/Downtown switcher.
 */
const DOWNTOWN_SEQUENCE: Record<string, string[]> = {
  A: ['14st8av', 'w4st', 'chambers'],
  C: ['14st8av', 'w4st', 'chambers'],
  E: ['14st8av', 'w4st'],
  L: ['union14', '14st8av'],
  F: ['w4st'],
  M: ['w4st'],
  '4': ['union14'],
  '5': ['union14'],
  '6': ['union14', 'canal'],
  N: ['union14', 'canal'],
  Q: ['union14', 'canal'],
  '2': ['chambers'],
  '3': ['chambers'],
  J: ['canal'],
};

export function lineSequence(line: string, direction: Direction): string[] {
  const downtown = DOWNTOWN_SEQUENCE[line] ?? [];
  return direction === 'downtown' ? downtown : [...downtown].reverse();
}

/** Remaining stops strictly after `stationId` along this line+direction. */
export function remainingStops(line: string, direction: Direction, stationId: string): string[] {
  const seq = lineSequence(line, direction);
  const idx = seq.indexOf(stationId);
  if (idx === -1) return [];
  return seq.slice(idx + 1);
}

/** Small deterministic string hash (FNV-1a), used to seed pseudo-random-but-stable demo data. */
export function hashStr(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
