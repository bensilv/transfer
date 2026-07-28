// Seed station list: id, real coordinates (used both for the live map and to
// resolve each station's real MTA stop_id — see data/gtfsStatic.ts) and the
// lines serving it.
//
// Coverage is intentionally scoped to five real, well-known Lower
// Manhattan / West Village stations (matching the station set explored in
// the Claude Design mockup) rather than the full ~472-station system.

export interface Station {
  id: string;
  name: string;
  /** Real-world coordinates, used to render the live map and to resolve the real GTFS stop_id. */
  lat: number;
  lon: number;
  /** Subway lines serving this station complex. */
  lines: string[];
}

export const STATIONS: Station[] = [
  { id: '14st8av', name: '14 St - 8 Av', lat: 40.7402, lon: -74.0021, lines: ['A', 'C', 'E', 'L'] },
  { id: 'w4st', name: 'W 4 St - Wash Sq', lat: 40.7318, lon: -74.0002, lines: ['A', 'C', 'E', 'F', 'M'] },
  { id: 'union14', name: 'Union Sq - 14 St', lat: 40.7359, lon: -73.9906, lines: ['4', '5', '6', 'L', 'N', 'Q'] },
  { id: 'chambers', name: 'Chambers St', lat: 40.7143, lon: -74.0089, lines: ['A', 'C', '2', '3'] },
  { id: 'canal', name: 'Canal St', lat: 40.7197, lon: -74.0026, lines: ['6', 'J', 'N', 'Q'] },
];

export function stationById(id: string): Station | undefined {
  return STATIONS.find((s) => s.id === id);
}

/**
 * Transfer lookup equivalent to a `transfers.txt` join: every other line
 * reachable at the same station complex as `line`.
 */
export function connectingLines(stationId: string, line: string): string[] {
  const st = stationById(stationId);
  if (!st) return [];
  return st.lines.filter((l) => l !== line);
}

/** All stations (complexes) that serve a given line, in no particular order. */
export function stationsForLine(line: string): Station[] {
  return STATIONS.filter((s) => s.lines.includes(line));
}
