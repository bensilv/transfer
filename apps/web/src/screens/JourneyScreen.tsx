import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fetchJourney } from '../api';
import { usePolledData } from '../hooks/usePolledData';
import { useNowTick } from '../hooks/useNowTick';
import { useJourneyStops } from '../hooks/useJourneyStops';
import { useLineShapes } from '../hooks/useLineShapes';
import { useViewportHeight } from '../hooks/useViewportHeight';
import { formatClock, formatMinutesAway, formatUpdatedAgo } from '../format';
import { LINE_COLORS, textColorFor } from '../lines';
import { pickDirectionLabels } from '../directionLabels';
import { buildRoutePath, pointAlong } from '../routeGeometry';
import { BottomSheet, SHEET_HANDLE_HEIGHT_PX } from '../components/BottomSheet';
import { StationMap, type RouteStopMarker } from '../components/StationMap';
import type { ActiveTrip, Direction } from '../types';

// Sheet snap fractions/caps — "default" leaves a clear strip of map visible
// above the sheet (the point of putting the map behind this screen at all),
// "full" leaves just the floating top bar showing, it never truly hits 100%.
const DEFAULT_SHEET_VH_FRACTION = 0.56;
const DEFAULT_SHEET_MAX_PX = 520;
const FULL_SHEET_TOP_GAP_PX = 10;
const SHEET_BOTTOM_SAFE_PADDING = 'max(20px, env(safe-area-inset-bottom))';
// How long a manual scroll in the stop list suppresses auto-scroll-to-active,
// and how long we ignore scroll events right after we trigger one ourselves
// (its own smooth-scroll animation) so it isn't mistaken for a manual one.
const MANUAL_SCROLL_SUPPRESS_MS = 8_000;
const OWN_SCROLL_IGNORE_MS = 700;

export function JourneyScreen({
  active,
  preview,
  onPreviewTransfer,
  onCancelPreview,
  onConfirmPreview,
  onGoHome,
}: {
  active: ActiveTrip;
  preview: ActiveTrip | null;
  onPreviewTransfer: (trip: ActiveTrip) => void;
  onCancelPreview: () => void;
  onConfirmPreview: () => void;
  onGoHome: () => void;
}) {
  const now = useNowTick();
  const viewportHeight = useViewportHeight();
  const shapes = useLineShapes();
  const displayed = preview ?? active;

  // Which direction's arrivals to show for connecting lines at each stop.
  // Defaults to whichever train is currently boarded, and resets to match
  // it again each time the rider actually boards a new one (confirming a
  // transfer) — but not while merely previewing, so toggling doesn't get
  // clobbered by a preview that hasn't been confirmed yet.
  const [transferDirection, setTransferDirection] = useState<Direction>(active.direction);
  useEffect(() => {
    setTransferDirection(active.direction);
  }, [active.tripId, active.direction]);

  // Identifies the leg itself (independent of which transfer-direction is
  // being displayed), so switching that toggle doesn't reset the
  // accumulated passed-stops history or re-fit the map to the route.
  const legKey = [displayed.tripId, displayed.line, displayed.direction, displayed.boardedStationId, displayed.boardedArrivalMs].join('|');
  const journeyKey = `${legKey}|${transferDirection}`;
  const { data, offline: fetchFailed, lastFetchTs, refresh, refreshing } = usePolledData(
    () => fetchJourney(displayed, transferDirection),
    journeyKey,
  );
  // "offline" covers both our own request failing and the backend reaching us
  // fine but failing to reach the live MTA feed for this request.
  const offline = fetchFailed || data?.status.online === false;

  const { stops, activeIndex, progress } = useJourneyStops(data?.stops, legKey, now);

  const isPreviewing = !!preview;
  const displayLineColor = LINE_COLORS[displayed.line] ?? '#0039A6';
  const displayLineTextColor = textColorFor(displayed.line);
  const headerDirectionLabel = data?.directionLabel ?? (displayed.direction === 'uptown' ? 'Uptown' : 'Downtown');
  const allTransfers = stops.flatMap((sp) => sp.transfers);
  const { toggle: transferToggleLabels, qualifierFor: transferQualifierFor } = pickDirectionLabels(allTransfers);

  // The route actually traveled so far, snapped onto the real track geometry
  // — recomputed only when the set of known stops for this leg changes (it
  // only ever grows, see useJourneyStops), not on every poll.
  const stopIdsKey = stops.map((s) => s.stationId).join(',');
  const routePath = useMemo(() => {
    if (stops.length < 2) return null;
    return buildRoutePath(shapes, displayed.line, stops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, displayed.line, stopIdsKey]);

  const trainPoint = useMemo(() => {
    if (!routePath) return null;
    const prevOffset = routePath.stopOffsets[Math.max(0, activeIndex - 1)] ?? 0;
    const nextOffset = routePath.stopOffsets[activeIndex] ?? prevOffset;
    return pointAlong(routePath, prevOffset + (nextOffset - prevOffset) * progress);
  }, [routePath, activeIndex, progress]);

  const routeStopMarkers: RouteStopMarker[] = stops.map((s, i) => ({
    id: s.stationId,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    color: displayLineColor,
    status: s.passed ? 'passed' : i === activeIndex ? 'active' : 'upcoming',
    arrivalBadge: i === 0 && now < s.arrivalMs ? formatMinutesAway(s.arrivalMs, now, offline) : null,
  }));

  // --- Floating top bar + sheet sizing ---
  const topBarRef = useRef<HTMLDivElement>(null);
  const [topBarHeight, setTopBarHeight] = useState(64);
  useLayoutEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setTopBarHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const statusRowRef = useRef<HTMLDivElement>(null);
  const [statusRowHeight, setStatusRowHeight] = useState(40);
  useLayoutEffect(() => {
    const el = statusRowRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setStatusRowHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const peekHeight = SHEET_HANDLE_HEIGHT_PX + statusRowHeight;
  const fullHeight = Math.max(peekHeight + 80, viewportHeight - topBarHeight - FULL_SHEET_TOP_GAP_PX);
  const defaultHeight = Math.max(
    peekHeight + 40,
    Math.min(Math.min(viewportHeight * DEFAULT_SHEET_VH_FRACTION, DEFAULT_SHEET_MAX_PX), fullHeight - 40),
  );
  const snapPoints = [peekHeight, defaultHeight, fullHeight];
  const [activeSnap, setActiveSnap] = useState(1);
  const [sheetHeightPx, setSheetHeightPx] = useState(defaultHeight);
  const showDetails = activeSnap > 0;

  // --- Auto-scroll the stop list to the active stop, unless the rider just
  // scrolled it themselves (see the two refs below). ---
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const ignoreScrollUntilRef = useRef(0);
  const suppressAutoScrollUntilRef = useRef(0);
  const activeStationId = stops[activeIndex]?.stationId;
  useEffect(() => {
    if (!activeStationId) return;
    if (Date.now() < suppressAutoScrollUntilRef.current) return;
    const el = rowRefs.current.get(activeStationId);
    if (!el) return;
    ignoreScrollUntilRef.current = Date.now() + OWN_SCROLL_IGNORE_MS;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeStationId]);
  const onListScroll = () => {
    if (Date.now() < ignoreScrollUntilRef.current) return;
    suppressAutoScrollUntilRef.current = Date.now() + MANUAL_SCROLL_SUPPRESS_MS;
  };

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <StationMap
        routes={routePath ? [{ color: displayLineColor, points: routePath.points }] : []}
        routeStops={routeStopMarkers}
        trainMarker={trainPoint ? { position: trainPoint, color: displayLineColor } : null}
        fitBounds={routePath ? { points: routePath.points, key: legKey } : undefined}
        obstructedBottomPx={sheetHeightPx}
      />

      <div
        ref={topBarRef}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2,
          paddingTop: 'max(14px, env(safe-area-inset-top))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px 10px' }}>
          {isPreviewing ? (
            <button onClick={onCancelPreview} style={circleBtnStyle}>‹</button>
          ) : (
            <button onClick={onGoHome} style={{ ...circleBtnStyle, fontSize: 15 }}>✕</button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', borderRadius: 20, padding: '5px 14px 5px 5px', boxShadow: '0 2px 10px rgba(0,0,0,0.18)' }}>
            <span
              style={{
                width: 26, height: 26, borderRadius: '50%', background: displayLineColor, color: displayLineTextColor,
                fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              {displayed.line}
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1a1a1a' }}>{headerDirectionLabel}</span>
          </div>
        </div>
      </div>

      <BottomSheet
        snapPoints={snapPoints}
        activeSnap={activeSnap}
        onSnapChange={setActiveSnap}
        onHeightChange={setSheetHeightPx}
        style={{ background: '#fff', borderRadius: '20px 20px 0 0', boxShadow: '0 -8px 24px rgba(0,0,0,0.14)' }}
      >
        <div ref={statusRowRef} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 10px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: offline ? '#e0433d' : '#1a9c53', flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: '#6b6b70' }}>{offline ? 'OFFLINE' : 'LIVE'}</span>
          <span style={{ fontSize: 12, color: '#9a9aa0' }}>&middot; {formatUpdatedAgo(lastFetchTs, now)}</span>
          <button onClick={refresh} style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: '50%', background: '#f1f1f3', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 14, color: '#555', display: 'inline-block', animation: refreshing ? 'spin 0.6s linear' : 'none' }}>&#8635;</span>
          </button>
        </div>

        {showDetails && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px 10px' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#8a8a90' }}>Show transfers toward</span>
              <div style={{ display: 'flex', background: '#f1f1f3', borderRadius: 10, padding: 2 }}>
                <button
                  onClick={() => setTransferDirection('downtown')}
                  style={{
                    padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    background: transferDirection === 'downtown' ? '#fff' : 'transparent',
                    color: transferDirection === 'downtown' ? '#1a1a1a' : '#8a8a90',
                  }}
                >
                  {transferToggleLabels.downtown}
                </button>
                <button
                  onClick={() => setTransferDirection('uptown')}
                  style={{
                    padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    background: transferDirection === 'uptown' ? '#fff' : 'transparent',
                    color: transferDirection === 'uptown' ? '#1a1a1a' : '#8a8a90',
                  }}
                >
                  {transferToggleLabels.uptown}
                </button>
              </div>
            </div>
            <div style={{ padding: '0 16px 8px' }}>
              <span style={{ fontSize: 11, fontStyle: 'italic', color: '#b0b0b6' }}>
                Transfer times reflect each connecting line&rsquo;s arrival after your train reaches that stop &mdash; not from right now.
              </span>
            </div>
          </>
        )}

        <div
          data-sheet-scroll
          onScroll={onListScroll}
          style={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch', borderTop: '1px solid #eee' }}
        >
          <div style={{ padding: `16px 16px ${SHEET_BOTTOM_SAFE_PADDING}` }}>
            {stops.map((sp, i) => {
              const isPassed = sp.passed;
              const isActive = i === activeIndex;
              return (
                <div
                  key={sp.stationId}
                  ref={(el) => {
                    if (el) rowRefs.current.set(sp.stationId, el);
                    else rowRefs.current.delete(sp.stationId);
                  }}
                  style={{ display: 'flex', gap: 12 }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14, flexShrink: 0 }}>
                    <span
                      className={isActive ? 'stop-dot-active' : undefined}
                      style={{
                        width: 12, height: 12, borderRadius: '50%',
                        background: isPassed ? '#c0c0c6' : displayLineColor,
                        border: '2px solid #fff', boxShadow: '0 0 0 2px #ddd', marginTop: 4, flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1, width: 2, background: '#e2e2e6', display: i === stops.length - 1 ? 'none' : 'block' }} />
                  </div>
                  <div style={{ flex: 1, paddingBottom: 22, opacity: isPassed ? 0.55 : 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a' }}>{sp.name}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#8a8a90', marginBottom: 8 }}>
                      {isPassed ? formatClock(sp.arrivalMs) : `${formatClock(sp.arrivalMs)} · ${stopMinsAway(sp.arrivalMs, now)}`}
                    </div>
                    {sp.transfers.length > 0 ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {sp.transfers.map((tr) => {
                          const noData = tr.arrivalMs === null || !tr.tripId;
                          const disabled = noData || isPassed;
                          const qualifier = transferQualifierFor(tr, transferDirection);
                          return (
                            <button
                              key={tr.line}
                              onClick={() => {
                                if (disabled) return;
                                onPreviewTransfer({ tripId: tr.tripId!, line: tr.line, direction: tr.direction, boardedStationId: sp.stationId, boardedArrivalMs: tr.arrivalMs! });
                              }}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 6px 6px', borderRadius: 20, background: '#f5f5f7', border: 'none', cursor: disabled ? 'default' : 'pointer' }}
                            >
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: tr.color, color: tr.textColor, fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                {tr.line}
                              </span>
                              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2 }}>
                                <span
                                  style={{
                                    fontSize: 13, fontWeight: 800,
                                    color: noData ? '#b0b0b6' : offline ? '#9a9aa0' : '#1a1a1a',
                                    fontStyle: !noData && offline ? 'italic' : 'normal',
                                  }}
                                >
                                  {noData ? 'NO DATA' : formatMinutesAway(tr.arrivalMs!, sp.arrivalMs, offline, '0 min')}
                                </span>
                                {qualifier && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: '#9a9aa0' }}>{qualifier}</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: '#9a9aa0' }}>No further connections</div>
                    )}
                  </div>
                </div>
              );
            })}
            {!data && <div style={{ fontSize: 13, color: '#9a9aa0', padding: '8px 2px' }}>Loading&hellip;</div>}
            {data && stops.length === 0 && (
              <div style={{ fontSize: 13, color: '#9a9aa0', padding: '8px 2px' }}>
                This trip continues beyond this prototype&rsquo;s seeded station coverage.
              </div>
            )}
          </div>
        </div>
      </BottomSheet>

      {isPreviewing && (
        <button
          onClick={onConfirmPreview}
          style={{ position: 'absolute', right: 16, bottom: 'max(24px, env(safe-area-inset-bottom))', padding: '13px 20px', borderRadius: 26, background: '#0039A6', color: '#fff', border: 'none', fontSize: 14, fontWeight: 800, boxShadow: '0 8px 20px rgba(0,0,0,0.3)', cursor: 'pointer', zIndex: 5 }}
        >
          Transfer &rarr;
        </button>
      )}
    </div>
  );
}

const circleBtnStyle: CSSProperties = {
  width: 32, height: 32, borderRadius: '50%', background: '#fff', border: 'none', fontSize: 16, fontWeight: 700, color: '#555', cursor: 'pointer',
  boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
};

function stopMinsAway(arrivalMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((arrivalMs - nowMs) / 60000));
  return mins < 1 ? 'now' : `${mins} min away`;
}
