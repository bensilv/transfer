import { STATIONS, connectingLines } from '../data/stations.js';
import { hashStr, remainingStops } from '../data/schedule.js';
import type { Arrival, Direction, JourneyStop, NearbyStationArrivals, RealtimeProvider } from './types.js';

const ARRIVALS_PER_LINE = 5;
const MIN_HEADWAY_MS = 2 * 60_000;
const HEADWAY_JITTER_MS = 9 * 60_000;
const HOP_BASE_MS = 3 * 60_000;
const HOP_JITTER_MS = 4 * 60_000;

const ALWAYS_ONLINE = { online: true, lastErrorMessage: null };

function pseudoRandom(seed: string): number {
  // Stable float in [0, 1) derived from the hash, independent of Date.now()
  // so repeated calls within the same demo session feel coherent.
  return (hashStr(seed) % 10_000) / 10_000;
}

/** Deterministic "next N arrivals of this line, in this direction, at this station, after `afterMs`". */
function generateArrivals(stationId: string, line: string, direction: Direction, afterMs: number): Arrival[] {
  const arrivals: Arrival[] = [];
  let t = afterMs;
  for (let slot = 0; slot < ARRIVALS_PER_LINE; slot++) {
    const jitter = pseudoRandom(`${stationId}:${line}:${direction}:${slot}:headway`);
    const headway = MIN_HEADWAY_MS + jitter * HEADWAY_JITTER_MS;
    t += headway;
    arrivals.push({
      tripId: `${line}-${direction}-${stationId}-${slot}`,
      line,
      direction,
      arrivalMs: Math.round(t),
    });
  }
  return arrivals;
}

/** Soonest arrival of `line` at `stationId`, across both directions, after `afterMs`. Deterministically absent ~1 in 6 times, mirroring how a connecting line can lack live predictions. */
function soonestConnectingArrival(stationId: string, line: string, afterMs: number): Arrival | null {
  const noData = hashStr(`${stationId}:${line}:${Math.floor(afterMs / (5 * 60_000))}`) % 6 === 0;
  if (noData) return null;
  const down = generateArrivals(stationId, line, 'downtown', afterMs)[0] ?? null;
  const up = generateArrivals(stationId, line, 'uptown', afterMs)[0] ?? null;
  if (!down) return up;
  if (!up) return down;
  return down.arrivalMs <= up.arrivalMs ? down : up;
}

export class MockRealtimeProvider implements RealtimeProvider {
  async getNearbyArrivals(direction: Direction): Promise<{ stations: NearbyStationArrivals[]; status: typeof ALWAYS_ONLINE }> {
    const now = Date.now();
    const stations = STATIONS.map((st) => ({
      stationId: st.id,
      arrivalsByLine: Object.fromEntries(st.lines.map((line) => [line, generateArrivals(st.id, line, direction, now)])),
    }));
    return { stations, status: ALWAYS_ONLINE };
  }

  async getJourney(params: {
    tripId: string;
    line: string;
    direction: Direction;
    boardedStationId: string;
    boardedArrivalMs: number;
  }): Promise<{ stops: JourneyStop[]; status: typeof ALWAYS_ONLINE }> {
    const { line, direction, boardedStationId, boardedArrivalMs } = params;
    const stopIds = remainingStops(line, direction, boardedStationId);
    const stops: JourneyStop[] = [];
    let prevId = boardedStationId;
    let prevArrival = boardedArrivalMs;
    for (const stationId of stopIds) {
      const hop = HOP_BASE_MS + pseudoRandom(`${prevId}:${stationId}:${line}:hop`) * HOP_JITTER_MS;
      const arrivalMs = Math.round(prevArrival + hop);
      const station = STATIONS.find((s) => s.id === stationId);
      const transfers = connectingLines(stationId, line).map((tLine) => {
        const best = soonestConnectingArrival(stationId, tLine, arrivalMs);
        return { line: tLine, direction: best?.direction ?? 'downtown', arrivalMs: best?.arrivalMs ?? null, tripId: best?.tripId ?? null };
      });
      stops.push({ stationId, name: station?.name ?? stationId, arrivalMs, transfers });
      prevId = stationId;
      prevArrival = arrivalMs;
    }
    return { stops, status: ALWAYS_ONLINE };
  }
}
