import { STATIONS } from './stations.js';

/**
 * Real MTA stop_id -> our station id, straight from the generated station
 * data (see scripts/generate-stations.ts), which already carries each
 * complex's real GTFS parent stop_id(s) from MTA's own dataset. A single
 * station can have several real stop_ids (e.g. "14 St/8 Av" is two separate
 * GTFS complexes — "14 St" (A/C/E, A31) and "8 Av" (L, L01) — joined only by
 * a free in-system transfer passageway), so this is real-id -> our-id
 * (many-to-one), not the other way around.
 */
function buildStationGtfsIds(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const station of STATIONS) {
    for (const gtfsId of station.gtfsStopIds) {
      result[gtfsId] = station.id;
    }
  }
  return result;
}

let cached: Record<string, string> | null = null;

/** Memoized for the life of the process/warm serverless instance. */
export function getStationGtfsIds(): Promise<Record<string, string>> {
  if (!cached) cached = buildStationGtfsIds();
  return Promise.resolve(cached);
}
