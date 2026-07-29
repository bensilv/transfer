import { Router } from 'express';
import { STATIONS, stationById } from '../data/stations.js';
import { haversineMeters } from '../data/geo.js';
import { LINE_COLORS, textColorFor } from '../data/lines.js';
import { getRealtimeProvider } from '../realtime/provider.js';
import type { Direction } from '../realtime/types.js';

export const router = Router();

// How many stations "nearby" returns by default, and the most a caller can
// ask for — keeps the common case (a rider's map view) from building and
// shipping arrivals for all ~450 stations system-wide on every poll.
const DEFAULT_NEARBY_LIMIT = 15;
const MAX_NEARBY_LIMIT = 100;

// Used to rank/cap stations when the caller doesn't supply a real lat/lon
// (e.g. before geolocation resolves) — roughly central Manhattan.
const DEFAULT_REFERENCE = { lat: 40.7318, lon: -74.0002 };

function parseDirection(v: unknown): Direction {
  return v === 'uptown' ? 'uptown' : 'downtown';
}

function parseFiniteNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseLimit(v: unknown): number {
  const n = parseFiniteNumber(v);
  if (n === null) return DEFAULT_NEARBY_LIMIT;
  return Math.max(1, Math.min(MAX_NEARBY_LIMIT, Math.round(n)));
}

router.get('/health', (_req, res) => {
  res.json({ serverTime: Date.now() });
});

router.get('/stations', (_req, res) => {
  res.json({
    serverTime: Date.now(),
    stations: STATIONS.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      lines: s.lines.map((line) => ({ line, color: LINE_COLORS[line], textColor: textColorFor(line) })),
    })),
  });
});

// Screen 1: nearby stations + per-line arrivals in the currently selected direction.
router.get('/stations/nearby', async (req, res) => {
  const direction = parseDirection(req.query.direction);
  const limit = parseLimit(req.query.limit);
  const lat = parseFiniteNumber(req.query.lat) ?? DEFAULT_REFERENCE.lat;
  const lon = parseFiniteNumber(req.query.lon) ?? DEFAULT_REFERENCE.lon;

  const nearest = [...STATIONS]
    .sort((a, b) => haversineMeters(lat, lon, a.lat, a.lon) - haversineMeters(lat, lon, b.lat, b.lon))
    .slice(0, limit);

  const { stations: arrivalsByStation, status } = await getRealtimeProvider().getNearbyArrivals(direction, nearest);
  const arrivalsById = new Map(arrivalsByStation.map((s) => [s.stationId, s.arrivalsByLine]));
  const directionLabelsById = new Map(arrivalsByStation.map((s) => [s.stationId, s.directionLabelsByLine]));
  const linesById = new Map(arrivalsByStation.map((s) => [s.stationId, s.lines]));

  const stations = nearest.map((s) => {
    const arrivalsByLine = arrivalsById.get(s.id) ?? {};
    const directionLabelsByLine = directionLabelsById.get(s.id) ?? {};
    const lines = linesById.get(s.id) ?? s.lines;
    return {
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      lines: lines.map((line) => ({
        line,
        color: LINE_COLORS[line],
        textColor: textColorFor(line),
        arrivals: (arrivalsByLine[line] ?? []).map((a) => ({
          tripId: a.tripId,
          arrivalMs: a.arrivalMs,
          terminalName: a.terminalStationId ? stationById(a.terminalStationId)?.name ?? null : null,
        })),
        directionLabels: directionLabelsByLine[line] ?? { uptown: 'Uptown', downtown: 'Downtown' },
      })),
    };
  });

  res.json({ serverTime: Date.now(), status, direction, stations });
});

// Screen 2 / transfer preview: remaining stops + transfer options for a specific trip,
// starting right after the stop the rider boarded (or is currently previewing from).
router.get('/journey', async (req, res) => {
  const { tripId, line, boardedStationId } = req.query as Record<string, string | undefined>;
  const direction = parseDirection(req.query.direction);
  const transferDirection = parseDirection(req.query.transferDirection);
  const boardedArrivalMs = Number(req.query.boardedArrivalMs);

  if (!tripId || !line || !boardedStationId || !Number.isFinite(boardedArrivalMs)) {
    res.status(400).json({ error: 'tripId, line, direction, boardedStationId, boardedArrivalMs are required' });
    return;
  }

  const { stops, status, directionLabel } = await getRealtimeProvider().getJourney({
    tripId,
    line,
    direction,
    transferDirection,
    boardedStationId,
    boardedArrivalMs,
  });

  res.json({
    serverTime: Date.now(),
    status,
    line,
    lineColor: LINE_COLORS[line],
    lineTextColor: textColorFor(line),
    direction,
    directionLabel,
    stops: stops.map((s) => ({
      stationId: s.stationId,
      name: s.name,
      arrivalMs: s.arrivalMs,
      transfers: s.transfers.map((t) => ({
        line: t.line,
        color: LINE_COLORS[t.line],
        textColor: textColorFor(t.line),
        direction: t.direction,
        arrivalMs: t.arrivalMs,
        tripId: t.tripId,
        directionLabels: t.directionLabels,
      })),
    })),
  });
});
