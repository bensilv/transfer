import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { transit_realtime } from 'gtfs-realtime-bindings';
import { STATIONS, connectingLines, stationById } from '../data/stations.js';
import type { Station } from '../data/stations.js';
import { FEED_GROUP_FOR_ROUTE, FEED_GROUPS } from '../data/lines.js';
import { getStationGtfsIds } from '../data/gtfsStatic.js';
import { directionLabel } from '../data/directionLabel.js';
import type {
  Arrival,
  Direction,
  DirectionLabels,
  JourneyStop,
  NearbyStationArrivals,
  ProviderStatus,
  RealtimeProvider,
} from './types.js';

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

/**
 * Every route id we know a feed group for. Used to check for live arrivals
 * beyond a station's scheduled lines — e.g. an A running local overnight
 * covering C's stops, or any other reroute/service change.
 */
const ALL_LINES = Object.keys(FEED_GROUP_FOR_ROUTE);

/** Upcoming arrivals kept per station/line/direction. Only ever future ones — see prune(). */
const MAX_ARRIVALS_PER_KEY = 8;
/** How long a departed arrival is kept before pruning, absorbing clock skew between the feed and us. */
const DEPARTED_ARRIVAL_GRACE_MS = 60_000;
/** How long a finished trip stays resolvable, so a rider still on its screen doesn't lose it the instant it terminates. */
const FINISHED_TRIP_GRACE_MS = 10 * 60_000;

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
    // value for several real stop_ids (see getStationGtfsIds).
    const ids = await getStationGtfsIds();
    for (const [gtfsId, stationId] of Object.entries(ids)) {
      this.stationByGtfsId.set(gtfsId, stationId);
    }
  }

  /**
   * Drops departed trains from both indexes.
   *
   * This is load-bearing, not housekeeping. A trip update only ever carries a
   * trip's *remaining* stops, so the moment a train passes a station that stop
   * disappears from the feed — and since `ingest` only replaces an entry when
   * the same tripId turns up again, nothing would ever evict it. Stale
   * arrivals sort earliest, so they'd take every slot under the
   * MAX_ARRIVALS_PER_KEY cap, and each index read filters to times still
   * ahead: the buckets would go permanently empty and every line would report
   * "no upcoming trains" the longer the instance stayed warm.
   */
  private prune(): void {
    const arrivalCutoff = Date.now() - DEPARTED_ARRIVAL_GRACE_MS;
    for (const [key, arrivals] of this.arrivalsIndex) {
      const upcoming = arrivals.filter((a) => a.arrivalMs >= arrivalCutoff);
      if (upcoming.length === arrivals.length) continue;
      if (upcoming.length === 0) this.arrivalsIndex.delete(key);
      else this.arrivalsIndex.set(key, upcoming);
    }
    // A trip is over once its final stop is behind us. The grace keeps a
    // just-finished trip resolvable for a rider still looking at it.
    const tripCutoff = Date.now() - FINISHED_TRIP_GRACE_MS;
    for (const [tripId, seq] of this.tripIndex) {
      if (seq[seq.length - 1].arrivalMs < tripCutoff) this.tripIndex.delete(tripId);
    }
  }

  /** Fetch + decode the given feed groups and merge their trip updates into the indexes. Returns error messages for any that failed. */
  private async refresh(groups: string[]): Promise<string[]> {
    this.prune();
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
    const arrivalCutoff = Date.now() - DEPARTED_ARRIVAL_GRACE_MS;
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

      // This trip's actual final stop in today's decode — reflects reroutes/
      // short-turns automatically, since it's read straight off the live feed
      // rather than a scheduled terminal.
      const terminalStationId = this.stationByGtfsId.get(baseStopId(seq[seq.length - 1].gtfsStopId)) ?? null;

      for (let i = 0; i < seq.length; i++) {
        const stop = seq[i];
        const stationId = this.stationByGtfsId.get(baseStopId(stop.gtfsStopId));
        if (!stationId) continue;
        // A feed's trip can still list a stop it's just called at; every read
        // of this index wants times ahead, so it would only burn a slot.
        if (stop.arrivalMs < arrivalCutoff) continue;
        const nextStop = seq[i + 1];
        const nextStationId = nextStop ? this.stationByGtfsId.get(baseStopId(nextStop.gtfsStopId)) ?? null : null;
        const key = `${stationId}:${stop.line}:${stop.direction}`;
        const arrival: Arrival = {
          tripId: stop.tripId,
          line: stop.line,
          direction: stop.direction,
          arrivalMs: stop.arrivalMs,
          terminalStationId,
          nextStationId,
        };
        const existing = this.arrivalsIndex.get(key) ?? [];
        const dedup = existing.filter((a) => a.tripId !== arrival.tripId && a.arrivalMs >= arrivalCutoff);
        dedup.push(arrival);
        dedup.sort((a, b) => a.arrivalMs - b.arrivalMs);
        this.arrivalsIndex.set(key, dedup.slice(0, MAX_ARRIVALS_PER_KEY));
      }
    }
  }

  private statusFrom(failures: string[]): ProviderStatus {
    return { online: failures.length === 0, lastErrorMessage: failures.length ? failures.join('; ') : null };
  }

  /**
   * Human label for one direction bucket at a station, derived from the
   * soonest live arrival there (its actual next stop + actual terminal) —
   * falls back to plain "Uptown"/"Downtown" text when there's no live trip
   * to derive it from yet (e.g. a long overnight gap).
   */
  private labelFor(
    stationId: string,
    dir: Direction,
    ids?: { terminalStationId: string | null; nextStationId: string | null },
  ): string {
    const from = stationById(stationId);
    if (!from) return dir === 'uptown' ? 'Uptown' : 'Downtown';
    const bearing = ids?.nextStationId ? stationById(ids.nextStationId) ?? null : null;
    const terminal = ids?.terminalStationId ? stationById(ids.terminalStationId) ?? null : null;
    return directionLabel(from, bearing, terminal, dir);
  }

  /**
   * Lines actually observed serving a station right now, in either direction,
   * per the live feed — regardless of whether they're part of scheduled
   * service there. This is how a reroute (an A running local overnight over
   * C's stops, a GO diversion, a short-turn, etc.) surfaces automatically:
   * the feed already carries those trip updates, decoded and indexed by real
   * stop match in `ingest`, independent of any station's scheduled lines.
   */
  private liveLines(stationId: string): string[] {
    const now = Date.now();
    return ALL_LINES.filter((line) =>
      (['uptown', 'downtown'] as const).some((dir) =>
        (this.arrivalsIndex.get(`${stationId}:${line}:${dir}`) ?? []).some((a) => a.arrivalMs >= now),
      ),
    );
  }

  /** Every line to show at a station: scheduled service plus anything live. */
  private effectiveLines(stationId: string): string[] {
    const scheduled = stationById(stationId)?.lines ?? [];
    return Array.from(new Set([...scheduled, ...this.liveLines(stationId)]));
  }

  /** Every other line reachable at a station right now: scheduled transfers plus anything live. */
  private effectiveConnectingLines(stationId: string, line: string): string[] {
    const scheduled = connectingLines(stationId, line);
    const live = this.liveLines(stationId).filter((l) => l !== line);
    return Array.from(new Set([...scheduled, ...live]));
  }

  private directionLabelsFor(stationId: string, line: string): DirectionLabels {
    const uptownSoonest = this.arrivalsIndex.get(`${stationId}:${line}:uptown`)?.[0];
    const downtownSoonest = this.arrivalsIndex.get(`${stationId}:${line}:downtown`)?.[0];
    return {
      uptown: this.labelFor(stationId, 'uptown', uptownSoonest),
      downtown: this.labelFor(stationId, 'downtown', downtownSoonest),
    };
  }

  async getNearbyArrivals(
    direction: Direction,
    targetStations: Station[],
  ): Promise<{ stations: NearbyStationArrivals[]; status: ProviderStatus }> {
    await this.ensureStationMapping();
    // Always fetch every feed group, not just the ones implied by scheduled
    // service — a reroute can put a train on a station that isn't on its
    // usual line's feed at all (rare, but the only way to catch it). There
    // are only 7 groups and they fetch in parallel, so this is cheap.
    const failures = await this.refresh(FEED_GROUPS);
    const now = Date.now();

    const stations = targetStations.map((st) => {
      const lines = this.effectiveLines(st.id);
      return {
        stationId: st.id,
        lines,
        arrivalsByLine: Object.fromEntries(
          lines.map((line) => [
            line,
            (this.arrivalsIndex.get(`${st.id}:${line}:${direction}`) ?? []).filter((a) => a.arrivalMs >= now),
          ]),
        ),
        directionLabelsByLine: Object.fromEntries(lines.map((line) => [line, this.directionLabelsFor(st.id, line)])),
      };
    });

    return { stations, status: this.statusFrom(failures) };
  }

  async getJourney(params: {
    tripId: string;
    line: string;
    direction: Direction;
    transferDirection: Direction;
    boardedStationId: string;
    boardedArrivalMs: number;
  }): Promise<{ stops: JourneyStop[]; status: ProviderStatus; directionLabel: string }> {
    await this.ensureStationMapping();

    // Always fetch every feed group — see getNearbyArrivals for why. Here it
    // also means transfer lines at stops ahead aren't limited to whatever
    // was reachable from a single primary-group fetch.
    const failures = await this.refresh(FEED_GROUPS);

    const seq = this.tripIndex.get(params.tripId);
    if (!seq) {
      return {
        stops: [],
        status: this.statusFrom([...failures, `trip ${params.tripId} not present in the current feed`]),
        directionLabel: this.labelFor(params.boardedStationId, params.direction),
      };
    }

    // A station id can map to several real stop_ids (e.g. two line groups in
    // the same complex on separate platforms) — this trip's sequence only
    // ever contains one of them, so match against whichever one it has.
    const boardedRealIds = new Set(
      [...this.stationByGtfsId.entries()].filter(([, ourId]) => ourId === params.boardedStationId).map(([realId]) => realId),
    );
    const boardedIdx = seq.findIndex((s) => boardedRealIds.has(baseStopId(s.gtfsStopId)));
    // Includes the boarded stop itself, not just what comes after it, so the
    // rider sees their whole journey (where they got on, where they are now,
    // where they're going) rather than only the road ahead.
    const rest = boardedIdx === -1 ? seq : seq.slice(boardedIdx);

    // Header label for the boarded/previewed trip itself: its actual next
    // stop from here decides Uptown/Downtown vs. crosstown, its actual final
    // stop this decode supplies the place name — same live derivation as
    // every other label, just anchored to this one specific trip.
    const bearingEntry = boardedIdx !== -1 ? seq[boardedIdx + 1] : seq[0];
    const bearingStationId = bearingEntry ? this.stationByGtfsId.get(baseStopId(bearingEntry.gtfsStopId)) ?? null : null;
    const terminalStationId = this.stationByGtfsId.get(baseStopId(seq[seq.length - 1].gtfsStopId)) ?? null;
    const headerDirectionLabel = this.labelFor(params.boardedStationId, params.direction, {
      terminalStationId,
      nextStationId: bearingStationId,
    });

    const knownStops = rest
      .map((stop) => ({ stop, stationId: this.stationByGtfsId.get(baseStopId(stop.gtfsStopId)) }))
      .filter((s): s is { stop: DecodedArrival; stationId: string } => !!s.stationId);

    const stops: JourneyStop[] = knownStops.map(({ stop, stationId }) => {
      const station = STATIONS.find((s) => s.id === stationId)!;
      const pickBest = (tLine: string, dir: Direction): Arrival | undefined => {
        const candidates = (this.arrivalsIndex.get(`${stationId}:${tLine}:${dir}`) ?? []).filter(
          (a) => a.arrivalMs >= stop.arrivalMs,
        );
        candidates.sort((a, b) => a.arrivalMs - b.arrivalMs);
        return candidates[0];
      };
      const transfers = this.effectiveConnectingLines(stationId, params.line).map((tLine) => {
        const best = pickBest(tLine, params.transferDirection);
        const directionLabels: DirectionLabels = {
          uptown: this.labelFor(stationId, 'uptown', pickBest(tLine, 'uptown')),
          downtown: this.labelFor(stationId, 'downtown', pickBest(tLine, 'downtown')),
        };
        return {
          line: tLine,
          direction: best?.direction ?? params.transferDirection,
          arrivalMs: best?.arrivalMs ?? null,
          tripId: best?.tripId ?? null,
          directionLabels,
        };
      });
      return { stationId, name: station.name, lat: station.lat, lon: station.lon, arrivalMs: stop.arrivalMs, transfers };
    });

    return { stops, status: this.statusFrom(failures), directionLabel: headerDirectionLabel };
  }
}
