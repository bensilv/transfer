export type Direction = 'downtown' | 'uptown';

export interface ProviderStatus {
  online: boolean;
  lastErrorMessage: string | null;
}

export interface ArrivalDto {
  tripId: string;
  arrivalMs: number;
}

export interface NearbyLine {
  line: string;
  color: string;
  textColor: string;
  arrivals: ArrivalDto[];
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
}

export interface JourneyStopDto {
  stationId: string;
  name: string;
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
