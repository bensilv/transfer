import { Router } from 'express';
import { STATIONS } from '../data/stations.js';
import { LINE_COLORS, textColorFor } from '../data/lines.js';
import { DATA_SOURCE } from '../config.js';
import { getRealtimeProvider } from '../realtime/provider.js';
import type { Direction } from '../realtime/types.js';

export const router = Router();

function parseDirection(v: unknown): Direction {
  return v === 'uptown' ? 'uptown' : 'downtown';
}

router.get('/health', (_req, res) => {
  res.json({ serverTime: Date.now(), dataSource: DATA_SOURCE });
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
  const { stations: arrivalsByStation, status } = await getRealtimeProvider().getNearbyArrivals(direction);
  const arrivalsById = new Map(arrivalsByStation.map((s) => [s.stationId, s.arrivalsByLine]));

  const stations = STATIONS.map((s) => {
    const arrivalsByLine = arrivalsById.get(s.id) ?? {};
    return {
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      lines: s.lines.map((line) => ({
        line,
        color: LINE_COLORS[line],
        textColor: textColorFor(line),
        arrivals: (arrivalsByLine[line] ?? []).map((a) => ({ tripId: a.tripId, arrivalMs: a.arrivalMs })),
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

  const { stops, status } = await getRealtimeProvider().getJourney({
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
      })),
    })),
  });
});
