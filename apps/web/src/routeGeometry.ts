/**
 * Turns a list of journey stops into a drawable path that follows the real
 * track geometry, by snapping the stops onto the route shapes already loaded
 * for the map overlay (public/subway-lines.geojson, see hooks/useLineShapes).
 *
 * Straight lines between stop coordinates would visibly cut corners wherever
 * the track curves (the 7 through Queens, the A over Jamaica Bay, anything in
 * Brooklyn), so instead we find which of a route's shape branches actually
 * fits the stops, then slice out the portion between the first and last one.
 *
 * Everything here works in a local planar projection in meters rather than in
 * degrees: over a single subway line's extent the distortion is far below the
 * ~8m simplification tolerance already baked into the shapes, and it makes
 * "distance along the path" a real unit that the train-position dot can
 * interpolate against.
 */
import type { LineShapeCollection } from './hooks/useLineShapes';

/** [lat, lon] — Leaflet's tuple order, not GeoJSON's. */
export type LatLngTuple = [number, number];

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RoutePath {
  /** The drawable path, ordered from the first stop to the last. */
  points: LatLngTuple[];
  /** Distance in meters along `points` of each input stop, same index order, non-decreasing. */
  stopOffsets: number[];
  /** Total length of `points`, meters. */
  lengthM: number;
  /** True when no shape fit the stops and `points` is just the stops joined by straight lines. */
  approximate: boolean;
}

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_AT_EQUATOR = 111_320;

/**
 * Mean per-stop distance from a candidate shape beyond which we assume none of
 * a route's branches actually serves these stops (e.g. the stops came from a
 * live reroute the static shapes don't know about) and fall back to straight
 * lines. A correct branch snaps within a few tens of meters — platform-vs-track
 * offsets and the shape simplification — so this is deliberately loose.
 */
const MAX_MEAN_SNAP_M = 350;

/**
 * How much longer than the stop-to-stop straight-line distance a sliced path
 * may be before we distrust it. Guards the case where a stop snaps onto the
 * wrong pass of a shape that doubles back on itself, which would otherwise
 * draw a highlight looping far outside the actual journey.
 */
const MAX_PATH_DETOUR_RATIO = 2.5;

interface Pt {
  x: number;
  y: number;
}

function project(lat: number, lon: number, lat0: number): Pt {
  return {
    x: lon * M_PER_DEG_LON_AT_EQUATOR * Math.cos((lat0 * Math.PI) / 180),
    y: lat * M_PER_DEG_LAT,
  };
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Cumulative distance from the start of the polyline to each of its vertices. */
function cumulativeLengths(pts: Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distance(pts[i - 1], pts[i]));
  return cum;
}

/** Closest point on the polyline to `p`, as a distance along it plus how far off it was. */
function nearestAlong(pts: Pt[], cum: number[], p: Pt): { along: number; distM: number } {
  let best = { along: 0, distM: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const proj = { x: a.x + t * dx, y: a.y + t * dy };
    const distM = distance(p, proj);
    if (distM < best.distM) best = { along: cum[i - 1] + t * Math.sqrt(lenSq), distM };
  }
  return best;
}

function snapAll(coords: LatLngTuple[], stops: LatLon[], lat0: number) {
  const pts = coords.map(([lat, lon]) => project(lat, lon, lat0));
  const cum = cumulativeLengths(pts);
  const snapped = stops.map((s) => nearestAlong(pts, cum, project(s.lat, s.lon, lat0)));
  return { cum, snapped };
}

function lerpLatLng(a: LatLngTuple, b: LatLngTuple, t: number): LatLngTuple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Point at `d` meters along a polyline, interpolating within the segment it lands in. */
function pointAtDistance(coords: LatLngTuple[], cum: number[], d: number): LatLngTuple {
  const total = cum[cum.length - 1];
  if (d <= 0) return coords[0];
  if (d >= total) return coords[coords.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const segLen = cum[i] - cum[i - 1];
  const t = segLen === 0 ? 0 : (d - cum[i - 1]) / segLen;
  return lerpLatLng(coords[i - 1], coords[i], t);
}

/** The sub-path between two distances along a polyline, with both ends cut exactly. */
function slicePath(coords: LatLngTuple[], cum: number[], startD: number, endD: number): LatLngTuple[] {
  const out: LatLngTuple[] = [pointAtDistance(coords, cum, startD)];
  for (let i = 0; i < coords.length; i++) {
    if (cum[i] > startD && cum[i] < endD) out.push(coords[i]);
  }
  out.push(pointAtDistance(coords, cum, endD));
  return out;
}

function straightPath(stops: LatLon[], lat0: number): RoutePath {
  const points: LatLngTuple[] = stops.map((s) => [s.lat, s.lon]);
  const cum = cumulativeLengths(points.map(([lat, lon]) => project(lat, lon, lat0)));
  return { points, stopOffsets: cum, lengthM: cum[cum.length - 1], approximate: true };
}

/**
 * Builds the path a rider actually travels between `stops` on `route`.
 *
 * Returns null only when there aren't two distinct stops to draw between; if
 * the shapes are missing or don't fit, it still returns a usable path with
 * `approximate: true` (straight lines) rather than nothing, since a slightly
 * corner-cutting highlight beats no highlight at all.
 */
export function buildRoutePath(
  shapes: LineShapeCollection | null,
  route: string,
  stops: LatLon[],
): RoutePath | null {
  if (stops.length < 2) return null;
  const lat0 = stops.reduce((sum, s) => sum + s.lat, 0) / stops.length;

  const fallback = straightPath(stops, lat0);
  // Everything below only makes sense against a path with some extent; two
  // stops mapped to the same coordinate (bad data) would divide by zero.
  if (fallback.lengthM <= 0) return null;

  let best: { coords: LatLngTuple[]; cum: number[]; alongs: number[]; meanSnapM: number } | null = null;
  for (const feature of shapes?.features ?? []) {
    if (feature.properties.route !== route) continue;
    let coords: LatLngTuple[] = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    if (coords.length < 2) continue;

    let { cum, snapped } = snapAll(coords, stops, lat0);
    // A route's shapes are stored per direction, so half of them run against
    // the rider's direction of travel. Flipping the shape (rather than the
    // offsets) keeps `points` in travel order for every consumer downstream.
    if (snapped[snapped.length - 1].along < snapped[0].along) {
      coords = [...coords].reverse();
      ({ cum, snapped } = snapAll(coords, stops, lat0));
    }

    const meanSnapM = snapped.reduce((sum, s) => sum + s.distM, 0) / snapped.length;
    if (best && meanSnapM >= best.meanSnapM) continue;

    // Enforce non-decreasing offsets: a stop sitting near a place where the
    // shape passes itself can otherwise snap onto the wrong pass and send the
    // train dot backwards mid-journey.
    const alongs = snapped.map((s) => s.along);
    for (let i = 1; i < alongs.length; i++) alongs[i] = Math.max(alongs[i], alongs[i - 1]);

    best = { coords, cum, alongs, meanSnapM };
  }

  if (!best || best.meanSnapM > MAX_MEAN_SNAP_M) return fallback;

  const startD = best.alongs[0];
  const endD = best.alongs[best.alongs.length - 1];
  if (endD - startD <= 0) return fallback;
  if (endD - startD > fallback.lengthM * MAX_PATH_DETOUR_RATIO) return fallback;

  const points = slicePath(best.coords, best.cum, startD, endD);
  return {
    points,
    stopOffsets: best.alongs.map((d) => d - startD),
    lengthM: endD - startD,
    approximate: false,
  };
}

/** Coordinate `distanceM` meters into a path — how the train dot rides along it. */
export function pointAlong(path: RoutePath, distanceM: number): LatLngTuple {
  const lat0 = path.points[0][0];
  const cum = cumulativeLengths(path.points.map(([lat, lon]) => project(lat, lon, lat0)));
  return pointAtDistance(path.points, cum, distanceM);
}
