import { useEffect, useRef } from 'react';
import { Circle, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { NearbyStation } from '../types';

const DEFAULT_CENTER: [number, number] = [40.7318, -74.0002]; // W 4 St - roughly the middle of our coverage area
const RECENTER_ZOOM = 15;
// Real-world radius (meters) rather than a pixel size, so the dots are actual
// map features that grow/shrink with zoom instead of fixed-size UI pins.
const STATION_RADIUS_M = 12;
const STATION_RADIUS_FOCUSED_M = 18;

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
 * just their literal last GPS fix. */
function TrackDotLocation({ dotOffsetPx, onChange }: { dotOffsetPx: number; onChange: (loc: { lat: number; lon: number }) => void }) {
  const map = useMapEvents({
    move: () => {
      const { lat, lng } = dotLatLng(map, dotOffsetPx);
      onChange({ lat, lon: lng });
    },
  });
  return null;
}

function RecenterOnce({ lat, lon, dotOffsetPx }: { lat: number; lon: number; dotOffsetPx: number }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const target = offsetCenterLatLng(map, lat, lon, RECENTER_ZOOM, dotOffsetPx);
    map.flyTo(target, RECENTER_ZOOM, { duration: 0.6 });
    // Only ever runs once, on the first location fix — deliberately ignores
    // later movement/offset changes, same as the map.flyTo call it replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
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
}: {
  stations: NearbyStation[];
  focusedId: string | null;
  onFocusStation: (id: string) => void;
  userLocation: { lat: number; lon: number } | null;
  /** Height (px) of UI overlaying the bottom of the map, e.g. the arrivals sheet. */
  obstructedBottomPx?: number;
  /** Called with the coordinate under the dot whenever the map pans or flies. */
  onDotLocationChange?: (loc: { lat: number; lon: number }) => void;
}) {
  const dotOffsetPx = obstructedBottomPx / 2;
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
        {userLocation && (
          <>
            <RecenterOnce lat={userLocation.lat} lon={userLocation.lon} dotOffsetPx={dotOffsetPx} />
            <RecenterButton lat={userLocation.lat} lon={userLocation.lon} dotOffsetPx={dotOffsetPx} />
            {onDotLocationChange && <TrackDotLocation dotOffsetPx={dotOffsetPx} onChange={onDotLocationChange} />}
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
