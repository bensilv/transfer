export type Direction = 'downtown' | 'uptown';

/** Human-facing label for each direction, computed live off the real-time feed instead of a fixed "Uptown"/"Downtown". */
export interface DirectionLabels {
  uptown: string;
  downtown: string;
}

export interface ProviderStatus {
  online: boolean;
  lastErrorMessage: string | null;
}

export interface ArrivalDto {
  tripId: string;
  arrivalMs: number;
  /** This specific train's actual current terminal — same-direction trains on a branching line (e.g. the A to Far Rockaway vs. Ozone Park) can differ. Null if not yet resolvable. */
  terminalName: string | null;
}

export interface NearbyLine {
  line: string;
  color: string;
  textColor: string;
  arrivals: ArrivalDto[];
  directionLabels: DirectionLabels;
}

export interface NearbyStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  lines: NearbyLine[];
}

export interface NearbyResponse {
  serverTime: number;
  status: ProviderStatus;
  direction: Direction;
  stations: NearbyStation[];
}

export interface TransferDto {
  line: string;
  color: string;
  textColor: string;
  direction: Direction;
  arrivalMs: number | null;
  tripId: string | null;
  directionLabels: DirectionLabels;
}

export interface JourneyStopDto {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  arrivalMs: number;
  transfers: TransferDto[];
}

export interface JourneyResponse {
  serverTime: number;
  status: ProviderStatus;
  line: string;
  lineColor: string;
  lineTextColor: string;
  direction: Direction;
  directionLabel: string;
  stops: JourneyStopDto[];
}

/** Identifies the trip a rider has boarded (or is previewing), enough to fetch a journey. */
export interface ActiveTrip {
  tripId: string;
  line: string;
  direction: Direction;
  boardedStationId: string;
  boardedArrivalMs: number;
}
