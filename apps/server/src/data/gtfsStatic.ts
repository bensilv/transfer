import JSZip from 'jszip';
import { parse } from 'csv-parse/sync';
import { STATIONS } from './stations.js';

// MTA's public static GTFS bundle for the subway (stops.txt, routes.txt,
// transfers.txt, etc.) — no API key required. MTA has reorganized where this
// lives before; if this URL 404s, check https://new.mta.info/developers for
// the current "GTFS Static" download link and override via GTFS_STATIC_URL.
const DEFAULT_GTFS_STATIC_URL = 'https://web.mta.info/developers/data/nyct/subway/google_transit.zip';

// A seeded station's coordinates should land within this radius of the real
// complex's stop_lat/stop_lon, or we treat it as "no confident match" rather
// than risk silently pairing the wrong station.
const MAX_MATCH_METERS = 300;

interface StaticStopRow {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  location_type: string;
  parent_station: string;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchStopsTxt(): Promise<StaticStopRow[]> {
  const url = process.env.GTFS_STATIC_URL || DEFAULT_GTFS_STATIC_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`static GTFS fetch failed: HTTP ${res.status} from ${url}`);
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  const stopsFile = zip.file('stops.txt');
  if (!stopsFile) throw new Error('static GTFS zip has no stops.txt');
  const csvText = await stopsFile.async('text');
  return parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as StaticStopRow[];
}

/**
 * Real MTA complex stop_id for each of our seeded stations, resolved by
 * matching stop_lat/stop_lon in the current static GTFS feed against our
 * seed coordinates (rather than trusting hardcoded IDs from memory, which
 * could never be verified against the live feed in the sandbox this was
 * built in — see data/stations.ts).
 */
export async function resolveStationGtfsIds(): Promise<Record<string, string>> {
  const rows = await fetchStopsTxt();
  // NYCT subway static GTFS: location_type 1 = a "station" (parent) node;
  // its children (platforms) have parent_station set to its stop_id and are
  // the ones GTFS-RT StopTimeUpdates actually reference (with an N/S suffix).
  const parents = rows.filter((r) => r.location_type === '1');

  const result: Record<string, string> = {};
  for (const seed of STATIONS) {
    let best: { id: string; dist: number } | null = null;
    for (const p of parents) {
      const lat = Number(p.stop_lat);
      const lon = Number(p.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const dist = haversineMeters(seed.lat, seed.lon, lat, lon);
      if (!best || dist < best.dist) best = { id: p.stop_id, dist };
    }
    if (best && best.dist <= MAX_MATCH_METERS) {
      result[seed.id] = best.id;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[gtfs-static] no static-GTFS station within ${MAX_MATCH_METERS}m of seed "${seed.name}" ` +
          `(closest was ${best ? Math.round(best.dist) + 'm away' : 'none found'}) — it will show no live data.`,
      );
    }
  }
  return result;
}

let cached: Promise<Record<string, string>> | null = null;

/** Memoized within a warm serverless instance; re-fetched fresh on cold start. */
export function getStationGtfsIds(): Promise<Record<string, string>> {
  if (!cached) {
    cached = resolveStationGtfsIds().catch((err) => {
      cached = null; // let the next call retry instead of caching a permanent failure
      // eslint-disable-next-line no-console
      console.warn('[gtfs-static] falling back to no real stop-id mapping:', err.message ?? err);
      return {};
    });
  }
  return cached;
}
