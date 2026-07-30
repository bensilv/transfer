import { useEffect, useRef } from 'react';
import { Circle, GeoJSON, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLineShapes } from '../hooks/useLineShapes';
import { SHEET_SETTLE_EASING, SHEET_SETTLE_MS } from './BottomSheet';
import { LINE_COLORS } from '../lines';
import type { NearbyStation } from '../types';
import type { LatLngTuple } from '../routeGeometry';

const DEFAULT_CENTER: LatLngTuple = [40.7318, -74.0002]; // W 4 St - roughly the middle of our coverage area
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
// The dot's on-screen position and the map pan that cancels it out both have to
// run against the bottom sheet's own settle animation, or the dot drifts across
// the map for a fifth of a second every time the sheet snaps.
const DOT_SETTLE_SEC = SHEET_SETTLE_MS / 1000;
const RECENTER_FLY_SEC = 0.6;
// After a recenter tap, a sheet resize within this window re-aims at the rider
// instead of holding the old view — the tap and the resize are one intent.
const RECENTER_GRACE_MS = 900;
const LINE_SHAPE_WEIGHT = 3;
const LINE_SHAPE_OPACITY = 0.75;
const LINE_SHAPE_FALLBACK_COLOR = '#888';
const ROUTE_HIGHLIGHT_WEIGHT = 6;
const ROUTE_HIGHLIGHT_OPACITY = 0.95;
const PASSED_STOP_COLOR = '#c0c0c6';

function lineShapeStyle(feature?: GeoJSON.Feature): L.PathOptions {
  const route = (feature?.properties?.route as string | undefined) ?? '';
  return {
    color: LINE_COLORS[route] ?? LINE_SHAPE_FALLBACK_COLOR,
    weight: LINE_SHAPE_WEIGHT,
    opacity: LINE_SHAPE_OPACITY,
    lineCap: 'round',
  };
}

function trainDotIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="train-dot" style="background:${color}"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
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
  settlingRef,
  onChange,
  onSettle,
}: {
  dotOffsetPx: number;
  /** Timestamp until which the map is compensating for a sheet resize. */
  settlingRef: React.RefObject<number>;
  onChange: (loc: { lat: number; lon: number }) => void;
  onSettle?: (loc: { lat: number; lon: number }) => void;
}) {
  const lastEmitRef = useRef(0);
  const map = useMapEvents({
    move: () => {
      // A compensating pan ends with the dot on exactly the coordinate it
      // started on, but its intermediate frames don't — dotOffsetPx has already
      // jumped to its new value while the map is still catching up. Reporting
      // those would flip the nearest station, which resizes the sheet, which
      // moves the dot again. The moveend below reports the settled truth.
      const now = performance.now();
      if (now < settlingRef.current) return;
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
 * Two jobs, both about keeping the blue dot honest:
 *
 * 1. Keep flying to the rider's location as new fixes arrive, until they touch
 *    the map themselves. A first GPS fix is often a coarse network/cell
 *    position that lands well before the chip actually locks on — how long
 *    that takes varies a lot (worse in dense areas like downtown Brooklyn), so
 *    rather than guess a timeout for "good enough," this just keeps correcting
 *    itself for as long as the rider hasn't taken over. `dragstart` (real user
 *    panning, not our own programmatic flyTo — flyTo never fires it) is what
 *    hands over control.
 *
 * 2. Compensate whenever the bottom sheet resizes. The dot is centred in the
 *    *unobstructed* part of the map (see CenterUserDot), so a taller or shorter
 *    sheet moves it vertically on screen — and since the dot is what marks the
 *    rider's position, that silently re-points it at a different block.
 *    Re-aiming the map over the same duration the sheet animates keeps the
 *    coordinate underneath the dot fixed: collapsing the sheet reveals more
 *    map instead of moving the rider.
 */
function AnchorUserDot({
  lat,
  lon,
  dotOffsetPx,
  settlingRef,
  recenterRef,
}: {
  lat: number;
  lon: number;
  dotOffsetPx: number;
  /** Shared with TrackDotLocation, which must ignore this animation's frames. */
  settlingRef: React.RefObject<number>;
  /** Filled in here so the recenter button flies via the same code that owns
   * the dot offset, instead of racing it with a second animation. */
  recenterRef: React.RefObject<(() => void) | null>;
}) {
  const interactedRef = useRef(false);
  const offsetRef = useRef(dotOffsetPx);
  // Window after a recenter tap during which a sheet resize re-aims at the
  // rider rather than preserving the old view. Tapping recenter drops the sheet
  // (see onRecenter), and the point of that tap is the rider's position, not
  // whatever the dot happened to be over beforehand.
  const recenterUntilRef = useRef(0);
  // Whatever coordinate the dot was sitting on when the current run of resizes
  // began. Re-aiming at a fixed anchor (rather than nudging by each delta) is
  // what keeps this exact when heights change in quick succession — Leaflet
  // drops the unfinished part of a pan it interrupts, so deltas would quietly
  // lose pixels every time.
  const anchorRef = useRef<L.LatLng | null>(null);
  const map = useMapEvents({
    dragstart: () => {
      interactedRef.current = true;
    },
    moveend: () => {
      settlingRef.current = 0;
    },
  });

  const aimAtRider = (offset: number, durationSec: number) => {
    settlingRef.current = performance.now() + durationSec * 1000 + 120;
    map.flyTo(offsetCenterLatLng(map, lat, lon, RECENTER_ZOOM, offset), RECENTER_ZOOM, { duration: durationSec });
  };

  recenterRef.current = () => {
    recenterUntilRef.current = performance.now() + RECENTER_GRACE_MS;
    aimAtRider(dotOffsetPx, RECENTER_FLY_SEC);
  };

  useEffect(() => {
    if (interactedRef.current) return;
    const target = offsetCenterLatLng(map, lat, lon, RECENTER_ZOOM, offsetRef.current);
    map.flyTo(target, RECENTER_ZOOM, { duration: RECENTER_FLY_SEC });
    // Deliberately not reactive to dotOffsetPx — a sheet resize is handled by
    // the pan below, which re-aims at wherever the dot already points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lat, lon]);

  useEffect(() => {
    const previousOffset = offsetRef.current;
    offsetRef.current = dotOffsetPx;
    if (previousOffset === dotOffsetPx) return;
    // Auto-follow still owns the view, so re-aim at the rider's own coordinate.
    // Reading the current one instead would be unreliable here: the follow
    // flyTo is often still in flight, and mid-animation getCenter() reports
    // wherever the map happens to be passing through.
    // A deadline rather than a flag: moveend clears it, but if a pan ever ends
    // without one the suppression expires on its own instead of sticking.
    const settling = performance.now() < settlingRef.current;
    if (!interactedRef.current || performance.now() < recenterUntilRef.current) {
      aimAtRider(dotOffsetPx, DOT_SETTLE_SEC);
      return;
    }
    settlingRef.current = performance.now() + SHEET_SETTLE_MS + 120;
    if (!settling) anchorRef.current = dotLatLng(map, previousOffset);
    const anchor = anchorRef.current!;
    map.panTo(offsetCenterLatLng(map, anchor.lat, anchor.lng, map.getZoom(), dotOffsetPx), {
      animate: true,
      duration: DOT_SETTLE_SEC,
      easeLinearity: 0.4,
    });
  }, [map, lat, lon, dotOffsetPx]);

  return null;
}

/** Pans the map back to the rider's real coordinates on demand — needed because
 * the blue dot itself is pinned to the viewport (see CenterUserDot) rather
 * than tracking the user's real position as the map is panned. The flight
 * itself belongs to AnchorUserDot; this only asks for it, so the two can't
 * animate the map toward different places at once. */
function RecenterButton({ onPress }: { onPress: () => void }) {
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
      onClick={onPress}
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
        // Matches the sheet's settle so the dot and the compensating map pan
        // (AnchorUserDot) travel together — the world under the dot holds still.
        transition: `top ${SHEET_SETTLE_MS}ms ${SHEET_SETTLE_EASING}`,
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

/**
 * Fits the map to `points` once whenever `fitKey` changes (e.g. a new leg is
 * boarded) — not on every render, since `points` is recomputed each poll and
 * a re-fit on every poll would fight the rider's own panning/zooming. Reads
 * `points`/`padBottomPx` through refs precisely so they can be current
 * without being reactive dependencies themselves.
 */
function FitBoundsOnChange({ points, padBottomPx, fitKey }: { points: LatLngTuple[]; padBottomPx: number; fitKey: string }) {
  const map = useMap();
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const padRef = useRef(padBottomPx);
  padRef.current = padBottomPx;

  useEffect(() => {
    const pts = pointsRef.current;
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], RECENTER_ZOOM);
      return;
    }
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [36, 60],
      paddingBottomRight: [36, padRef.current + 36],
      maxZoom: RECENTER_ZOOM + 1,
    });
    // fitKey (not `points`/`padBottomPx`) intentionally drives this: re-fit
    // once per leg, not once per poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);

  return null;
}

export interface RouteHighlight {
  color: string;
  points: LatLngTuple[];
}

export type RouteStopStatus = 'passed' | 'active' | 'upcoming';

export interface RouteStopMarker {
  id: string;
  name: string;
  lat: number;
  lon: number;
  color: string;
  status: RouteStopStatus;
  /** e.g. "5 min" — shown as a small callout at the stop while a boarded/selected train hasn't arrived there yet. Null/undefined hides it. */
  arrivalBadge?: string | null;
}

export interface TrainMarker {
  position: LatLngTuple;
  color: string;
}

export function StationMap({
  stations,
  focusedId,
  onFocusStation,
  userLocation,
  obstructedBottomPx = 0,
  onDotLocationChange,
  onDotLocationSettled,
  onRecenter,
  routes,
  routeStops,
  trainMarker,
  fitBounds,
}: {
  stations?: NearbyStation[];
  focusedId?: string | null;
  onFocusStation?: (id: string) => void;
  userLocation?: { lat: number; lon: number } | null;
  /** Height (px) of UI overlaying the bottom of the map, e.g. the arrivals sheet. */
  obstructedBottomPx?: number;
  /** Called with the coordinate under the dot whenever the map pans or flies. */
  onDotLocationChange?: (loc: { lat: number; lon: number }) => void;
  /** Called once a pan/fly settles (moveend), not on every intermediate frame — for callers that need to re-fetch rather than just re-sort. */
  onDotLocationSettled?: (loc: { lat: number; lon: number }) => void;
  /** Fires when the rider taps "recenter", before the map flies — the point of
   * that tap is to see the map, so callers should get their bottom sheet out of
   * the way. The flight itself re-aims at whatever height the sheet ends on. */
  onRecenter?: () => void;
  /** One highlighted path per journey leg drawn so far, heavier and brighter than the base network overlay. */
  routes?: RouteHighlight[];
  /** Stops along the highlighted route(s), styled by whether the train has passed, is at, or hasn't reached them yet. */
  routeStops?: RouteStopMarker[];
  /** A single moving dot representing the train's current interpolated position. */
  trainMarker?: TrainMarker | null;
  /** Fits the map to these points once per `key` change — e.g. once per boarded leg, not on every poll. */
  fitBounds?: { points: LatLngTuple[]; key: string };
}) {
  const dotOffsetPx = obstructedBottomPx / 2;
  // Deadline until which the map is animating to absorb a bottom-sheet resize.
  // Shared because the dot's location tracker has to sit that animation out.
  const settlingRef = useRef(0);
  const recenterRef = useRef<(() => void) | null>(null);
  const lineShapes = useLineShapes();
  const initialCenter: LatLngTuple = userLocation
    ? [userLocation.lat, userLocation.lon]
    : (fitBounds?.points[0] ?? DEFAULT_CENTER);
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
      <MapContainer
        center={initialCenter}
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
            <AnchorUserDot
              lat={userLocation.lat}
              lon={userLocation.lon}
              dotOffsetPx={dotOffsetPx}
              settlingRef={settlingRef}
              recenterRef={recenterRef}
            />
            <RecenterButton
              onPress={() => {
                // Sheet first: the resize it triggers lands inside the recenter
                // grace window, so the flight aims at the final layout.
                onRecenter?.();
                recenterRef.current?.();
              }}
            />
            {(onDotLocationChange || onDotLocationSettled) && (
              <TrackDotLocation
                dotOffsetPx={dotOffsetPx}
                settlingRef={settlingRef}
                onChange={onDotLocationChange ?? (() => {})}
                onSettle={onDotLocationSettled}
              />
            )}
          </>
        )}
        {fitBounds && <FitBoundsOnChange points={fitBounds.points} padBottomPx={obstructedBottomPx} fitKey={fitBounds.key} />}
        {routes?.map((r, i) => (
          <Polyline
            key={i}
            positions={r.points}
            pathOptions={{ color: r.color, weight: ROUTE_HIGHLIGHT_WEIGHT, opacity: ROUTE_HIGHLIGHT_OPACITY, lineCap: 'round' }}
          />
        ))}
        {stations?.map((st) => {
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
              eventHandlers={onFocusStation ? { click: () => onFocusStation(st.id) } : undefined}
            >
              {focused && (
                <Tooltip permanent direction="top" offset={[0, -12]} className="station-label-tooltip">
                  {st.name}
                </Tooltip>
              )}
            </Circle>
          );
        })}
        {routeStops?.map((s) => {
          const passed = s.status === 'passed';
          const active = s.status === 'active';
          return (
            <Circle
              key={s.id}
              center={[s.lat, s.lon]}
              radius={active ? STATION_RADIUS_FOCUSED_M : STATION_RADIUS_M}
              pathOptions={{
                color: '#fff',
                weight: 2,
                fillColor: passed ? PASSED_STOP_COLOR : s.color,
                fillOpacity: passed ? 0.7 : 1,
              }}
            >
              {active && (
                <Tooltip permanent direction="top" offset={[0, -12]} className="station-label-tooltip">
                  {s.name}
                </Tooltip>
              )}
              {s.arrivalBadge && (
                <Tooltip permanent direction="right" offset={[12, 0]} className="arrival-badge-tooltip">
                  {s.arrivalBadge}
                </Tooltip>
              )}
            </Circle>
          );
        })}
        {trainMarker && <Marker position={trainMarker.position} icon={trainDotIcon(trainMarker.color)} />}
      </MapContainer>
      {userLocation && <CenterUserDot obstructedBottomPx={obstructedBottomPx} />}
    </div>
  );
}
