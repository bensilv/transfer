import { useEffect, useRef } from 'react';
import { Circle, GeoJSON, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLineShapes } from '../hooks/useLineShapes';
import { LINE_COLORS } from '../lines';
import type { NearbyStation } from '../types';

const DEFAULT_CENTER: [number, number] = [40.7318, -74.0002]; // W 4 St - roughly the middle of our coverage area
const RECENTER_ZOOM = 15;
// Real-world radius (meters) rather than a pixel size, so the dots are actual
// map features that grow/shrink with zoom instead of fixed-size UI pins.
const STATION_RADIUS_M = 12;
const STATION_RADIUS_FOCUSED_M = 18;
// Caps how often onDotLocationChange fires during a drag/fly gesture. The
// underlying 'move' event fires on essentially every rendered frame (~60/s),
// which is more often than the nearest-station leader needs to be
// recomputed — in a dense cluster of stations that leader can otherwise flip
// on nearly every frame, reading as a flickering selection. This keeps the
// map itself buttery (throttling is on the callback, not the pan/zoom) while
// visibly slowing how often the rest of the UI reacts.
const DOT_LOCATION_THROTTLE_MS = 150;
// A fix at or under this radius (meters) is treated as good enough to trust
// for the map's one-time initial recenter — a coarse first fix (see
// RecenterOnce) shouldn't win just because it happened to arrive first.
const RECENTER_GOOD_ACCURACY_M = 65;
// Caps how long the initial recenter waits for a good fix before giving up
// and using the best one seen so far — covers devices (e.g. desktop, or GPS
// stuck indoors) where accuracy may never dip below the threshold above.
const RECENTER_MAX_WAIT_MS = 4000;
const LINE_SHAPE_WEIGHT = 3;
const LINE_SHAPE_OPACITY = 0.75;
const LINE_SHAPE_FALLBACK_COLOR = '#888';

function lineShapeStyle(feature?: GeoJSON.Feature): L.PathOptions {
  const route = (feature?.properties?.route as string | undefined) ?? '';
  return {
    color: LINE_COLORS[route] ?? LINE_SHAPE_FALLBACK_COLOR,
    weight: LINE_SHAPE_WEIGHT,
    opacity: LINE_SHAPE_OPACITY,
    lineCap: 'round',
  };
}

/**
 * The blue dot sits above true viewport center (see CenterUserDot), so
 * flying straight to [lat, lon] would center it too low, under the bottom
 * sheet. Shifting the fly-to target itself — rather than panning after the
 * fact — keeps the motion a single smooth animation and lands the real
 * coordinate exactly under the dot.
 */
function offsetCenterLatLng(map: L.Map, lat: number, lon: number, zoom: number, upByPx: number): L.LatLng {
  const point = map.project([lat, lon], zoom).add([0, upByPx]);
  return map.unproject(point, zoom);
}

/** Inverse of offsetCenterLatLng: given the map's current true center, finds
 * the coordinate actually sitting under the (visually offset) dot. */
function dotLatLng(map: L.Map, upByPx: number): L.LatLng {
  const point = map.project(map.getCenter(), map.getZoom()).subtract([0, upByPx]);
  return map.unproject(point, map.getZoom());
}

/** Reports the coordinate under the dot every time the map pans or flies —
 * lets the rest of the app (e.g. "nearest station" sorting) treat "wherever
 * the pinned dot is pointing" as the rider's current reference point, not
 * just their literal last GPS fix. Also reports once a pan/fly *settles*
 * (moveend) — distinct from the continuous `move` stream — so callers that
 * need to re-fetch from the server (not just re-sort what's already loaded)
 * can do it once per gesture instead of on every intermediate frame. */
function TrackDotLocation({
  dotOffsetPx,
  onChange,
  onSettle,
}: {
  dotOffsetPx: number;
  onChange: (loc: { lat: number; lon: number }) => void;
  onSettle?: (loc: { lat: number; lon: number }) => void;
}) {
  const lastEmitRef = useRef(0);
  const map = useMapEvents({
    move: () => {
      const now = performance.now();
      if (now - lastEmitRef.current < DOT_LOCATION_THROTTLE_MS) return;
      lastEmitRef.current = now;
      const { lat, lng } = dotLatLng(map, dotOffsetPx);
      onChange({ lat, lon: lng });
    },
    moveend: () => {
      // Flush unconditionally so the final position is never left stale
      // behind the throttle window once the gesture actually stops.
      lastEmitRef.current = performance.now();
      const { lat, lng } = dotLatLng(map, dotOffsetPx);
      onChange({ lat, lon: lng });
      onSettle?.({ lat, lon: lng });
    },
  });
  return null;
}

/**
 * Flies to the rider's location exactly once — but waits (briefly) for a fix
 * accurate enough to trust, rather than the very first watchPosition callback,
 * which on phones is often a fast, coarse network/cell fix that lands before
 * the GPS chip actually locks on. Tracks the best fix seen so far so a
 * transient dip in accuracy can't win over an earlier better one, and gives
 * up after RECENTER_MAX_WAIT_MS so devices whose accuracy never improves
 * (desktop, GPS stuck indoors) still get centered on something.
 */
function RecenterOnce({
  lat,
  lon,
  accuracy,
  dotOffsetPx,
}: {
  lat: number;
  lon: number;
  accuracy: number | null;
  dotOffsetPx: number;
}) {
  const map = useMap();
  const done = useRef(false);
  const bestRef = useRef<{ lat: number; lon: number; accuracy: number } | null>(null);
  const startRef = useRef<number | null>(null);

  const flyToBest = () => {
    if (done.current || !bestRef.current) return;
    done.current = true;
    const { lat: bestLat, lon: bestLon } = bestRef.current;
    const target = offsetCenterLatLng(map, bestLat, bestLon, RECENTER_ZOOM, dotOffsetPx);
    map.flyTo(target, RECENTER_ZOOM, { duration: 0.6 });
  };

  useEffect(() => {
    if (done.current) return;
    if (startRef.current === null) startRef.current = Date.now();
    if (!bestRef.current || accuracy === null || accuracy < bestRef.current.accuracy) {
      bestRef.current = { lat, lon, accuracy: accuracy ?? Infinity };
    }
    if (accuracy !== null && accuracy <= RECENTER_GOOD_ACCURACY_M) {
      flyToBest();
      return;
    }
    const elapsed = Date.now() - startRef.current;
    if (elapsed >= RECENTER_MAX_WAIT_MS) {
      flyToBest();
      return;
    }
    const timer = setTimeout(flyToBest, RECENTER_MAX_WAIT_MS - elapsed);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lat, lon, accuracy]);

  return null;
}

/** Pans the map back to the rider's real coordinates on demand — needed because
 * the blue dot itself is pinned to the viewport (see CenterUserDot) rather
 * than tracking the user's real position as the map is panned. */
function RecenterButton({ lat, lon, dotOffsetPx }: { lat: number; lon: number; dotOffsetPx: number }) {
  const map = useMap();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Leaflet's own mousedown/click/wheel listeners on the map container run
    // as plain DOM listeners, ahead of React's synthetic ones — a React
    // stopPropagation() here is too late to stop them, so without this the
    // map swallows every tap on the button as a drag/zoom gesture instead.
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }, []);
  return (
    <button
      ref={ref}
      onClick={() => {
        const target = offsetCenterLatLng(map, lat, lon, RECENTER_ZOOM, dotOffsetPx);
        map.flyTo(target, RECENTER_ZOOM, { duration: 0.6 });
      }}
      aria-label="Recenter on my location"
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        zIndex: 1000,
        width: 44,
        height: 44,
        borderRadius: '50%',
        background: '#fff',
        border: 'none',
        boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" fill="#0b6efd" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="#0b6efd" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="12" r="7" stroke="#0b6efd" strokeWidth="1.6" />
      </svg>
    </button>
  );
}

/** The rider's "you are here" indicator, pinned to the viewport rather than
 * to a geographic coordinate — panning the map moves the world underneath it
 * instead of moving the dot off-center. Centered in the space above the
 * bottom sheet (obstructedBottomPx) rather than the full viewport, so a tall
 * sheet never covers it. */
function CenterUserDot({ obstructedBottomPx }: { obstructedBottomPx: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: `calc((100% - ${obstructedBottomPx}px) / 2)`,
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 500,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#0b6efd',
          border: '3px solid #fff',
          boxShadow: '0 0 0 5px rgba(11,110,253,0.25)',
        }}
      />
    </div>
  );
}

export function StationMap({
  stations,
  focusedId,
  onFocusStation,
  userLocation,
  obstructedBottomPx = 0,
  onDotLocationChange,
  onDotLocationSettled,
}: {
  stations: NearbyStation[];
  focusedId: string | null;
  onFocusStation: (id: string) => void;
  userLocation: { lat: number; lon: number; accuracy: number | null } | null;
  /** Height (px) of UI overlaying the bottom of the map, e.g. the arrivals sheet. */
  obstructedBottomPx?: number;
  /** Called with the coordinate under the dot whenever the map pans or flies. */
  onDotLocationChange?: (loc: { lat: number; lon: number }) => void;
  /** Called once a pan/fly settles (moveend), not on every intermediate frame — for callers that need to re-fetch rather than just re-sort. */
  onDotLocationSettled?: (loc: { lat: number; lon: number }) => void;
}) {
  const dotOffsetPx = obstructedBottomPx / 2;
  const lineShapes = useLineShapes();
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
      <MapContainer
        center={userLocation ? [userLocation.lat, userLocation.lon] : DEFAULT_CENTER}
        zoom={14}
        zoomControl={false}
        attributionControl={true}
        style={{ position: 'absolute', inset: 0 }}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        />
        {lineShapes && <GeoJSON data={lineShapes} style={lineShapeStyle} />}
        {userLocation && (
          <>
            <RecenterOnce
              lat={userLocation.lat}
              lon={userLocation.lon}
              accuracy={userLocation.accuracy}
              dotOffsetPx={dotOffsetPx}
            />
            <RecenterButton lat={userLocation.lat} lon={userLocation.lon} dotOffsetPx={dotOffsetPx} />
            {(onDotLocationChange || onDotLocationSettled) && (
              <TrackDotLocation
                dotOffsetPx={dotOffsetPx}
                onChange={onDotLocationChange ?? (() => {})}
                onSettle={onDotLocationSettled}
              />
            )}
          </>
        )}
        {stations.map((st) => {
          const focused = st.id === focusedId;
          return (
            <Circle
              key={st.id}
              center={[st.lat, st.lon]}
              radius={focused ? STATION_RADIUS_FOCUSED_M : STATION_RADIUS_M}
              pathOptions={{
                color: '#fff',
                weight: 2,
                fillColor: st.lines[0]?.color ?? '#0039A6',
                fillOpacity: 1,
              }}
              eventHandlers={{ click: () => onFocusStation(st.id) }}
            >
              {focused && (
                <Tooltip permanent direction="top" offset={[0, -12]} className="station-label-tooltip">
                  {st.name}
                </Tooltip>
              )}
            </Circle>
          );
        })}
      </MapContainer>
      {userLocation && <CenterUserDot obstructedBottomPx={obstructedBottomPx} />}
    </div>
  );
}
