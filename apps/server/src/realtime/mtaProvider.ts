import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { transit_realtime } from 'gtfs-realtime-bindings';
import { STATIONS, connectingLines } from '../data/stations.js';
import { FEED_GROUP_FOR_ROUTE } from '../data/lines.js';
import { getStationGtfsIds } from '../data/gtfsStatic.js';
import type { Arrival, Direction, JourneyStop, NearbyStationArrivals, ProviderStatus, RealtimeProvider } from './types.js';

// MTA's public GTFS-RT protobuf feeds. No API key required (MTA opened these
// up in 2019). One feed per line group, not one per route.
// Reference: https://api.mta.info/#/subwayRealTimeFeeds
const FEED_URL: Record<string, string> = {
  '1234567': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  ace: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  bdfm: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  g: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  jz: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  nqrw: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  l: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
};

const ALL_NEEDED_GROUPS = Array.from(
  new Set(STATIONS.flatMap((s) => s.lines).map((l) => FEED_GROUP_FOR_ROUTE[l]).filter((g): g is string => !!g)),
);

interface DecodedArrival {
  tripId: string;
  line: string;
  direction: Direction;
  /** Real MTA stop_id, e.g. "A31N" (base complex id + N/S direction suffix). */
  gtfsStopId: string;
  arrivalMs: number;
}

/** Every remaining stop_time_update for one trip, in feed order. Used to build journeys. */
type TripSequence = DecodedArrival[];

function toMillis(time: transit_realtime.TripUpdate.IStopTimeEvent['time'] | null | undefined): number | null {
  if (time === null || time === undefined) return null;
  const seconds = typeof time === 'number' ? time : Number(time);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * NYCT stop_ids end in "N" (northbound, ~uptown) or "S" (southbound,
 * ~downtown) for the platform-specific child stop. This is the same
 * convention every open-source NYC subway GTFS-RT client relies on, since
 * the feed doesn't carry an explicit direction enum for the subway extension.
 */
function directionFromStopId(gtfsStopId: string): Direction | null {
  const suffix = gtfsStopId.slice(-1);
  if (suffix === 'N') return 'uptown';
  if (suffix === 'S') return 'downtown';
  return null;
}

function baseStopId(gtfsStopId: string): string {
  return gtfsStopId.slice(0, -1);
}

/**
 * Fetches MTA's real GTFS-RT feeds on demand, within each request — this runs
 * as a Vercel serverless function, so there's no persistent process to run a
 * background poll loop on. `arrivalsIndex`/`tripIndex` are still instance
 * fields (not request-local variables): a warm serverless instance reuses
 * this object across nearby invocations, so a fresh request quietly benefits
 * from the previous request's decode too, without depending on it.
 */
export class MtaGtfsRealtimeProvider implements RealtimeProvider {
  /** `${stationId}:${line}:${direction}` -> arrivals, most recent successful decode. */
  private arrivalsIndex = new Map<string, Arrival[]>();
  /** tripId -> ordered remaining stops for that trip, most recent successful decode. */
  private tripIndex = new Map<string, TripSequence>();
  /** real base stop_id (no N/S suffix) -> our internal station id. */
  private stationByGtfsId = new Map<string, string>();

  private async ensureStationMapping(): Promise<void> {
    if (this.stationByGtfsId.size > 0) return;
    // Real GTFS stop_id -> our station id; a station id can appear as the
    // value for several real stop_ids (see resolveStationGtfsIds).
    const ids = await getStationGtfsIds();
    for (const [gtfsId, stationId] of Object.entries(ids)) {
      this.stationByGtfsId.set(gtfsId, stationId);
    }
  }

  /** Fetch + decode the given feed groups and merge their trip updates into the indexes. Returns error messages for any that failed. */
  private async refresh(groups: string[]): Promise<string[]> {
    const results = await Promise.allSettled(groups.map((g) => this.fetchGroup(g)));
    return results
      .map((r, i) => (r.status === 'rejected' ? `${groups[i]}: ${r.reason?.message ?? r.reason}` : null))
      .filter((m): m is string => m !== null);
  }

  private async fetchGroup(group: string): Promise<void> {
    const url = FEED_URL[group];
    const res = await fetch(url, { headers: { accept: 'application/x-protobuf' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
    this.ingest(feed);
  }

  private ingest(feed: transit_realtime.FeedMessage): void {
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu || !tu.trip) continue;
      const line = tu.trip.routeId;
      if (!line) continue;
      const tripId = tu.trip.tripId || entity.id;

      const seq: TripSequence = [];
      for (const stu of tu.stopTimeUpdate ?? []) {
        const gtfsStopId = stu.stopId;
        const direction = gtfsStopId ? directionFromStopId(gtfsStopId) : null;
        const arrivalMs = toMillis(stu.arrival?.time) ?? toMillis(stu.departure?.time);
        if (!gtfsStopId || !direction || arrivalMs === null) continue;
        seq.push({ tripId, line, direction, gtfsStopId, arrivalMs });
      }
      if (seq.length === 0) continue;
      this.tripIndex.set(tripId, seq);

      for (const stop of seq) {
        const stationId = this.stationByGtfsId.get(baseStopId(stop.gtfsStopId));
        if (!stationId) continue;
        const key = `${stationId}:${stop.line}:${stop.direction}`;
        const arrival: Arrival = { tripId: stop.tripId, line: stop.line, direction: stop.direction, arrivalMs: stop.arrivalMs };
        const existing = this.arrivalsIndex.get(key) ?? [];
        const dedup = existing.filter((a) => a.tripId !== arrival.tripId);
        dedup.push(arrival);
        dedup.sort((a, b) => a.arrivalMs - b.arrivalMs);
        this.arrivalsIndex.set(key, dedup.slice(0, 8));
      }
    }
  }

  private statusFrom(failures: string[]): ProviderStatus {
    return { online: failures.length === 0, lastErrorMessage: failures.length ? failures.join('; ') : null };
  }

  async getNearbyArrivals(direction: Direction): Promise<{ stations: NearbyStationArrivals[]; status: ProviderStatus }> {
    await this.ensureStationMapping();
    const failures = await this.refresh(ALL_NEEDED_GROUPS);
    const now = Date.now();

    const stations = STATIONS.map((st) => ({
      stationId: st.id,
      arrivalsByLine: Object.fromEntries(
        st.lines.map((line) => [
          line,
          (this.arrivalsIndex.get(`${st.id}:${line}:${direction}`) ?? []).filter((a) => a.arrivalMs >= now),
        ]),
      ),
    }));

    return { stations, status: this.statusFrom(failures) };
  }

  async getJourney(params: {
    tripId: string;
    line: string;
    direction: Direction;
    transferDirection: Direction;
    boardedStationId: string;
    boardedArrivalMs: number;
  }): Promise<{ stops: JourneyStop[]; status: ProviderStatus }> {
    await this.ensureStationMapping();

    const primaryGroup = FEED_GROUP_FOR_ROUTE[params.line];
    const failures = primaryGroup ? await this.refresh([primaryGroup]) : [`no feed group known for line ${params.line}`];

    const seq = this.tripIndex.get(params.tripId);
    if (!seq) {
      return { stops: [], status: this.statusFrom([...failures, `trip ${params.tripId} not present in the current feed`]) };
    }

    // A station id can map to several real stop_ids (e.g. two line groups in
    // the same complex on separate platforms) — this trip's sequence only
    // ever contains one of them, so match against whichever one it has.
    const boardedRealIds = new Set(
      [...this.stationByGtfsId.entries()].filter(([, ourId]) => ourId === params.boardedStationId).map(([realId]) => realId),
    );
    const boardedIdx = seq.findIndex((s) => boardedRealIds.has(baseStopId(s.gtfsStopId)));
    const rest = boardedIdx === -1 ? seq : seq.slice(boardedIdx + 1);

    // Figure out which additional feeds we need for connecting lines at the
    // stops ahead, and fetch only the ones the primary-group refresh above
    // didn't already cover.
    const knownStops = rest
      .map((stop) => ({ stop, stationId: this.stationByGtfsId.get(baseStopId(stop.gtfsStopId)) }))
      .filter((s): s is { stop: DecodedArrival; stationId: string } => !!s.stationId);

    const extraGroups = Array.from(
      new Set(
        knownStops
          .flatMap(({ stationId }) => connectingLines(stationId, params.line))
          .map((tLine) => FEED_GROUP_FOR_ROUTE[tLine])
          .filter((g): g is string => !!g && g !== primaryGroup),
      ),
    );
    const moreFailures = extraGroups.length ? await this.refresh(extraGroups) : [];

    const stops: JourneyStop[] = knownStops.map(({ stop, stationId }) => {
      const station = STATIONS.find((s) => s.id === stationId)!;
      const transfers = connectingLines(stationId, params.line).map((tLine) => {
        const candidates = (this.arrivalsIndex.get(`${stationId}:${tLine}:${params.transferDirection}`) ?? []).filter(
          (a) => a.arrivalMs >= stop.arrivalMs,
        );
        candidates.sort((a, b) => a.arrivalMs - b.arrivalMs);
        const best = candidates[0];
        return { line: tLine, direction: best?.direction ?? params.transferDirection, arrivalMs: best?.arrivalMs ?? null, tripId: best?.tripId ?? null };
      });
      return { stationId, name: station.name, arrivalMs: stop.arrivalMs, transfers };
    });

    return { stops, status: this.statusFrom([...failures, ...moreFailures]) };
  }
}
