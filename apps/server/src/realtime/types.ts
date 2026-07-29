import type { Station } from '../data/stations.js';

export type Direction = 'uptown' | 'downtown';

/** A single predicted arrival of a specific trip at a specific station. */
export interface Arrival {
  tripId: string;
  line: string;
  direction: Direction;
  /** Predicted arrival time, epoch milliseconds. */
  arrivalMs: number;
}

export interface ProviderStatus {
  online: boolean;
  lastErrorMessage: string | null;
}

export interface TransferArrival {
  line: string;
  direction: Direction;
  /** null when the connecting line has no live prediction (-> "NO DATA" in the UI). */
  arrivalMs: number | null;
  /** The connecting trip's id, needed if the rider previews/boards this transfer. Null alongside a null arrivalMs. */
  tripId: string | null;
}

export interface JourneyStop {
  stationId: string;
  name: string;
  /** Predicted arrival time of the active trip at this stop, epoch ms. */
  arrivalMs: number;
  transfers: TransferArrival[];
}

export interface NearbyStationArrivals {
  stationId: string;
  arrivalsByLine: Record<string, Arrival[]>;
}

/**
 * Source of truth for live arrivals: MtaGtfsRealtimeProvider fetches the real
 * public MTA GTFS-RT feeds on demand, within each request (no background
 * process — this runs as a Vercel serverless function, which can't rely on a
 * persistent timer). Each call reports its own ProviderStatus (rather than a
 * shared/cached one) since there's no persistent poll loop to ask.
 */
export interface RealtimeProvider {
  /** Arrivals by line, in the given direction, for exactly the given stations — one call, not one per station. */
  getNearbyArrivals(
    direction: Direction,
    stations: Station[],
  ): Promise<{ stations: NearbyStationArrivals[]; status: ProviderStatus }>;
  /**
   * Remaining-stop journey for a specific trip the user has already boarded,
   * starting from `boardedStationId`/`boardedArrivalMs` (the arrival they tapped).
   */
  getJourney(params: {
    tripId: string;
    line: string;
    direction: Direction;
    /** Which direction's arrivals to show for each connecting line at each stop. */
    transferDirection: Direction;
    boardedStationId: string;
    boardedArrivalMs: number;
  }): Promise<{ stops: JourneyStop[]; status: ProviderStatus }>;
}
