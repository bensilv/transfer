import { useMemo, useRef } from 'react';
import type { JourneyStopDto } from '../types';

export interface DisplayJourneyStop extends JourneyStopDto {
  /** True once this stop has dropped out of the live feed, i.e. the train has already left it. */
  passed: boolean;
}

export interface JourneyStopsResult {
  /** Every stop seen for this leg so far, boarding stop first, in route order. Passed stops are kept, not dropped. */
  stops: DisplayJourneyStop[];
  /** Index into `stops` of the train's current/next stop (the first one not yet passed). */
  activeIndex: number;
  /**
   * How far the train is between `stops[activeIndex - 1]` and `stops[activeIndex]`,
   * 0..1, estimated from predicted arrival times vs. now. 0 at/before the previous
   * stop's predicted arrival, 1 at/after the active stop's. Always 0 when
   * activeIndex is 0 (still at, or not yet departed, the boarding stop).
   */
  progress: number;
}

/**
 * The live journey feed only ever reports a trip's *remaining* stops — once
 * the train passes one, it's gone from the response entirely (see
 * mtaProvider's getJourney). That's the right shape for "what's still ahead
 * of me," but the UI wants the rider's whole trip to stay visible with
 * earlier stops greyed out, not removed. This accumulates every stop seen
 * across polls for the current leg and marks anything that has since
 * disappeared from the feed as `passed` — a stop is never un-passed once
 * marked, since a real train doesn't go back to a stop it left.
 *
 * `legKey` identifies the leg (e.g. tripId + boardedStationId + boardedArrivalMs)
 * — the accumulated history resets whenever it changes, so switching trains
 * (a fresh board or a confirmed transfer) starts a clean stop list rather
 * than carrying the previous train's stops into the new one.
 */
export function useJourneyStops(rawStops: JourneyStopDto[] | undefined, legKey: string, nowMs: number): JourneyStopsResult {
  // Mutated directly during render, same pattern usePolledData already uses
  // for fetcherRef: this is pure derived cache keyed off (legKey, rawStops
  // identity), not state that needs to trigger its own re-render.
  const accRef = useRef<{ legKey: string; order: string[]; byId: Map<string, DisplayJourneyStop> }>({
    legKey: '',
    order: [],
    byId: new Map(),
  });

  const stops = useMemo(() => {
    const acc = accRef.current;
    if (acc.legKey !== legKey) {
      acc.legKey = legKey;
      acc.order = [];
      acc.byId = new Map();
    }

    if (rawStops && rawStops.length > 0) {
      const liveIds = new Set(rawStops.map((s) => s.stationId));
      // Mark anything we'd previously seen but that's no longer in the feed
      // as passed. Checked before merging the new stops in, so a stop can
      // never flip back to un-passed if it briefly reappears.
      for (const id of acc.order) {
        const prev = acc.byId.get(id);
        if (prev && !prev.passed && !liveIds.has(id)) {
          acc.byId.set(id, { ...prev, passed: true });
        }
      }
      for (const s of rawStops) {
        const prev = acc.byId.get(s.stationId);
        if (!prev) acc.order.push(s.stationId);
        acc.byId.set(s.stationId, { ...s, passed: false });
      }
    }

    return acc.order.map((id) => acc.byId.get(id)!);
  }, [rawStops, legKey]);

  const activeIndex = useMemo(() => {
    const idx = stops.findIndex((s) => !s.passed);
    return idx === -1 ? Math.max(0, stops.length - 1) : idx;
  }, [stops]);

  const progress = useMemo(() => {
    if (activeIndex <= 0) return 0;
    const prev = stops[activeIndex - 1];
    const active = stops[activeIndex];
    const span = active.arrivalMs - prev.arrivalMs;
    if (span <= 0) return 1;
    return Math.max(0, Math.min(1, (nowMs - prev.arrivalMs) / span));
  }, [stops, activeIndex, nowMs]);

  return { stops, activeIndex, progress };
}
