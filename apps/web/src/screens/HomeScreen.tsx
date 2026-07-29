import { useEffect, useRef, useState } from 'react';
import { fetchNearby } from '../api';
import { usePolledData } from '../hooks/usePolledData';
import { useGeolocation } from '../hooks/useGeolocation';
import { useNowTick } from '../hooks/useNowTick';
import { formatMinutesAway } from '../format';
import { haversineMeters } from '../geo';
import { StationMap } from '../components/StationMap';
import type { ActiveTrip, Direction, NearbyStation } from '../types';

export function HomeScreen({
  direction,
  onSetDirection,
  focusedStationId,
  onFocusStation,
  onSelectArrival,
}: {
  direction: Direction;
  onSetDirection: (d: Direction) => void;
  focusedStationId: string | null;
  onFocusStation: (id: string) => void;
  onSelectArrival: (trip: ActiveTrip) => void;
}) {
  const geo = useGeolocation();
  const now = useNowTick();

  // Wherever the pinned dot on the map currently points — starts at the
  // rider's real GPS fix, but tracks the map as they pan it (see
  // StationMap's onDotLocationChange), since the dot itself is no longer
  // tied to their literal position once they've moved the map.
  const [dotLocation, setDotLocation] = useState<{ lat: number; lon: number } | null>(null);
  const sortLocation = dotLocation ?? (geo.lat !== null && geo.lon !== null ? { lat: geo.lat, lon: geo.lon } : null);

  // Distinct from `dotLocation`: updates only once a pan/fly *settles*
  // (StationMap's onDotLocationSettled, i.e. moveend), not on every
  // intermediate drag frame. This is what the server-capped "nearby" set is
  // actually fetched around, so moving the pin refetches which stations show
  // up — not just re-sorting whatever was already loaded — without spamming
  // the API mid-gesture. Falls back to sortLocation before the first
  // settle (e.g. the very first geo fix, before any pan has happened).
  const [fetchLocation, setFetchLocation] = useState<{ lat: number; lon: number } | null>(null);
  const effectiveFetchLocation = fetchLocation ?? sortLocation;
  const fetchLocationKey = effectiveFetchLocation
    ? `${effectiveFetchLocation.lat.toFixed(4)},${effectiveFetchLocation.lon.toFixed(4)}`
    : 'none';

  const { data, offline: fetchFailed } = usePolledData(
    () => fetchNearby(direction, effectiveFetchLocation),
    `${direction}:${fetchLocationKey}`,
  );
  // "offline" covers both our own request failing and the backend reaching us
  // fine but failing to reach the live MTA feed for this request.
  const offline = fetchFailed || data?.status.online === false;

  const unsortedStations = data?.stations ?? [];
  // Order by distance from the rider's current reference point, nearest
  // first, so the default focus and the station-picker strip both start
  // with the closest station.
  const stations: NearbyStation[] = sortLocation
    ? [...unsortedStations].sort(
        (a, b) =>
          haversineMeters(sortLocation.lat, sortLocation.lon, a.lat, a.lon) -
          haversineMeters(sortLocation.lat, sortLocation.lon, b.lat, b.lon),
      )
    : unsortedStations;
  const activeFocusId = focusedStationId ?? stations[0]?.id ?? null;
  const focused = stations.find((s) => s.id === activeFocusId) ?? null;

  const sheetRef = useRef<HTMLDivElement>(null);
  const [sheetHeightPx, setSheetHeightPx] = useState(0);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSheetHeightPx(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <StationMap
        stations={stations}
        focusedId={activeFocusId}
        onFocusStation={onFocusStation}
        userLocation={geo.lat !== null && geo.lon !== null ? { lat: geo.lat, lon: geo.lon, accuracy: geo.accuracy } : null}
        obstructedBottomPx={sheetHeightPx}
        onDotLocationChange={setDotLocation}
        onDotLocationSettled={setFetchLocation}
      />

      <div
        ref={sheetRef}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1,
          background: '#fff',
          borderRadius: '20px 20px 0 0',
          boxShadow: '0 -8px 24px rgba(0,0,0,0.14)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '78%',
        }}
      >
        <div style={{ width: 36, height: 5, borderRadius: 3, background: '#d0d0d5', margin: '10px auto 4px', flexShrink: 0 }} />

        {focused && (
          <div style={{ padding: '2px 18px 12px', flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 19, fontWeight: 800, color: '#1a1a1a' }}>{focused.name}</div>
              <div style={{ display: 'flex', background: '#f1f1f3', borderRadius: 10, padding: 2 }}>
                <button
                  onClick={() => onSetDirection('downtown')}
                  style={{
                    padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    background: direction === 'downtown' ? '#fff' : 'transparent',
                    color: direction === 'downtown' ? '#1a1a1a' : '#8a8a90',
                  }}
                >
                  Downtown
                </button>
                <button
                  onClick={() => onSetDirection('uptown')}
                  style={{
                    padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    background: direction === 'uptown' ? '#fff' : 'transparent',
                    color: direction === 'uptown' ? '#1a1a1a' : '#8a8a90',
                  }}
                >
                  Uptown
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {focused.lines.map((ln) => (
                <div key={ln.line} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      width: 26, height: 26, borderRadius: '50%', background: ln.color, color: ln.textColor,
                      fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}
                  >
                    {ln.line}
                  </span>
                  <div data-noscroll style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2, flex: 1, minWidth: 0 }}>
                    {ln.arrivals.length === 0 && !offline && (
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#9a9aa0', padding: '7px 0' }}>No upcoming trains</span>
                    )}
                    {ln.arrivals.map((a) => (
                      <button
                        key={a.tripId}
                        onClick={() =>
                          onSelectArrival({ tripId: a.tripId, line: ln.line, direction, boardedStationId: focused.id, boardedArrivalMs: a.arrivalMs })
                        }
                        style={{
                          fontSize: 16, fontWeight: 800, padding: '7px 13px', borderRadius: 9, background: '#eef1ff',
                          color: offline ? '#9a9aa0' : '#1a1a1a', fontStyle: offline ? 'italic' : 'normal',
                          border: 'none', whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
                        }}
                      >
                        {formatMinutesAway(a.arrivalMs, now, offline)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '10px 16px 16px', borderTop: '1px solid #eee', flexShrink: 0 }}>
          {stations.map((st) => (
            <button
              key={st.id}
              onClick={() => onFocusStation(st.id)}
              style={{
                flexShrink: 0, minWidth: 150, padding: 12, borderRadius: 14, background: '#f5f5f7', textAlign: 'left', cursor: 'pointer',
                border: `2px solid ${st.id === activeFocusId ? '#0039A6' : 'transparent'}`,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a1a', marginBottom: 6 }}>{st.name}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {st.lines.map((ln) => (
                  <span
                    key={ln.line}
                    style={{
                      width: 20, height: 20, borderRadius: '50%', background: ln.color, color: ln.textColor,
                      fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}
                  >
                    {ln.line}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
