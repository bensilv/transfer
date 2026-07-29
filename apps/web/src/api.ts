import type { ActiveTrip, Direction, JourneyResponse, NearbyResponse } from './types';

// In production (the Vercel build), the API is served from the same origin
// as the static site (see vercel.json), so relative /api/* paths just work.
// Locally, the frontend and backend run as two separate dev servers.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:8787');

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function fetchNearby(
  direction: 'downtown' | 'uptown',
  loc?: { lat: number; lon: number } | null,
  limit?: number,
): Promise<NearbyResponse> {
  const params = new URLSearchParams({ direction });
  if (loc) {
    params.set('lat', String(loc.lat));
    params.set('lon', String(loc.lon));
  }
  if (limit !== undefined) params.set('limit', String(limit));
  return getJson(`/api/stations/nearby?${params.toString()}`);
}

export function fetchJourney(trip: ActiveTrip, transferDirection: Direction): Promise<JourneyResponse> {
  const params = new URLSearchParams({
    tripId: trip.tripId,
    line: trip.line,
    direction: trip.direction,
    transferDirection,
    boardedStationId: trip.boardedStationId,
    boardedArrivalMs: String(trip.boardedArrivalMs),
  });
  return getJson(`/api/journey?${params.toString()}`);
}
