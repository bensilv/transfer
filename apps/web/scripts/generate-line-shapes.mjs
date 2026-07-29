/**
 * Regenerates public/subway-lines.geojson from MTA's static GTFS subway feed
 * (web.mta.info/developers/data/nyct/subway/google_transit.zip), which
 * contains the actual physical path of every route as a sequence of lat/lon
 * points (shapes.txt), attributed to a route via trips.txt.
 *
 * Output is a FeatureCollection of LineStrings, each tagged with the route id
 * it belongs to (properties.route) so the client can color it via the
 * existing LINE_COLORS table (src/lines.ts) — no color is embedded here.
 *
 * Not part of the build; run manually whenever MTA changes service patterns:
 *   node scripts/generate-line-shapes.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZIP_URL = 'http://web.mta.info/developers/data/nyct/subway/google_transit.zip';

// Express/shuttle variants and Staten Island Railway collapse onto the base
// route id our LINE_COLORS table (and this app's station coverage) uses.
// SI (Staten Island Railway) has no stations in this app's coverage area, so
// its shapes are dropped rather than remapped.
const ROUTE_REMAP = { '6X': '6', '7X': '7', FX: 'F', GS: 'S', FS: 'S', H: 'S' };
const EXCLUDED_ROUTES = new Set(['SI']);

// Degrees of lat/lon slack allowed when simplifying (~8m at NYC's latitude) —
// invisible at any zoom level a phone map would actually be viewed at.
const SIMPLIFY_TOLERANCE_DEG = 0.00008;

function canonicalRoute(routeId) {
  return ROUTE_REMAP[routeId] ?? routeId;
}

function parseCsvLine(line) {
  return line.split(',');
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const [px, py] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  const clampedT = Math.max(0, Math.min(1, t));
  const projX = x1 + clampedT * dx;
  const projY = y1 + clampedT * dy;
  return Math.hypot(px - projX, py - projY);
}

/** Standard Douglas-Peucker polyline simplification. */
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const start = points[0];
  const end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], start, end);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }
  if (maxDist <= tolerance) return [start, end];
  const left = simplify(points.slice(0, maxIdx + 1), tolerance);
  const right = simplify(points.slice(maxIdx), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** Order-independent signature used to drop near-duplicate shapes (e.g. the
 * uptown/downtown mirror of the same physical track) within a route. */
function signature(points) {
  const sampleCount = Math.min(12, points.length);
  const picked = [];
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.round((i * (points.length - 1)) / Math.max(1, sampleCount - 1));
    const [lat, lon] = points[idx];
    picked.push(`${lat.toFixed(3)},${lon.toFixed(3)}`);
  }
  picked.sort();
  return picked.join('|');
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'mta-gtfs-'));
  try {
    console.log(`[generate-line-shapes] downloading ${ZIP_URL}`);
    const res = await fetch(ZIP_URL);
    if (!res.ok) throw new Error(`GTFS zip fetch failed: HTTP ${res.status}`);
    const zipPath = join(workDir, 'google_transit.zip');
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

    execFileSync('unzip', ['-o', '-q', zipPath, 'trips.txt', 'shapes.txt', '-d', workDir]);

    // shape_id -> route_id (first trip using a shape_id determines its route;
    // shape_ids are already per-route-per-direction, so this is unambiguous).
    const shapeRoute = new Map();
    const tripsLines = readFileSync(join(workDir, 'trips.txt'), 'utf8').split('\n');
    const tripsHeader = parseCsvLine(tripsLines[0]);
    const routeIdCol = tripsHeader.indexOf('route_id');
    const shapeIdCol = tripsHeader.indexOf('shape_id');
    for (let i = 1; i < tripsLines.length; i++) {
      const line = tripsLines[i];
      if (!line) continue;
      const cols = parseCsvLine(line);
      const shapeId = cols[shapeIdCol];
      if (shapeId && !shapeRoute.has(shapeId)) shapeRoute.set(shapeId, cols[routeIdCol]);
    }

    // shape_id -> ordered [lat, lon] points.
    const shapePoints = new Map();
    const shapesLines = readFileSync(join(workDir, 'shapes.txt'), 'utf8').split('\n');
    const shapesHeader = parseCsvLine(shapesLines[0]);
    const sIdCol = shapesHeader.indexOf('shape_id');
    const sSeqCol = shapesHeader.indexOf('shape_pt_sequence');
    const sLatCol = shapesHeader.indexOf('shape_pt_lat');
    const sLonCol = shapesHeader.indexOf('shape_pt_lon');
    for (let i = 1; i < shapesLines.length; i++) {
      const line = shapesLines[i];
      if (!line) continue;
      const cols = parseCsvLine(line);
      const id = cols[sIdCol];
      let arr = shapePoints.get(id);
      if (!arr) {
        arr = [];
        shapePoints.set(id, arr);
      }
      arr.push({
        seq: Number(cols[sSeqCol]),
        lat: Number(cols[sLatCol]),
        lon: Number(cols[sLonCol]),
      });
    }

    // Group retained (deduped) shapes by canonical route.
    const seenSignatures = new Map(); // route -> Set<signature>
    const features = [];
    let rawPointCount = 0;
    let simplifiedPointCount = 0;

    for (const [shapeId, rawRoute] of shapeRoute) {
      if (EXCLUDED_ROUTES.has(rawRoute)) continue;
      const pts = shapePoints.get(shapeId);
      if (!pts || pts.length < 2) continue;
      pts.sort((a, b) => a.seq - b.seq);
      const points = pts.map((p) => [p.lat, p.lon]);

      const route = canonicalRoute(rawRoute);
      let sigs = seenSignatures.get(route);
      if (!sigs) {
        sigs = new Set();
        seenSignatures.set(route, sigs);
      }
      const sig = signature(points);
      if (sigs.has(sig)) continue;
      sigs.add(sig);

      rawPointCount += points.length;
      const simplified = simplify(points, SIMPLIFY_TOLERANCE_DEG);
      simplifiedPointCount += simplified.length;

      features.push({
        type: 'Feature',
        properties: { route },
        geometry: {
          type: 'LineString',
          // GeoJSON coordinates are [lon, lat], the reverse of the source data.
          coordinates: simplified.map(([lat, lon]) => [lon, lat]),
        },
      });
    }

    const geojson = { type: 'FeatureCollection', features };
    const outPath = fileURLToPath(new URL('../public/subway-lines.geojson', import.meta.url));
    writeFileSync(outPath, JSON.stringify(geojson));

    const routeCount = new Set(features.map((f) => f.properties.route)).size;
    console.log(
      `[generate-line-shapes] wrote ${features.length} shapes across ${routeCount} routes ` +
        `(${rawPointCount} -> ${simplifiedPointCount} points) to ${outPath}`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
