import { useEffect, useRef } from 'react';
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { NearbyStation } from '../types';

const DEFAULT_CENTER: [number, number] = [40.7318, -74.0002]; // W 4 St - roughly the middle of our coverage area

function stationIcon(color: string, focused: boolean): L.DivIcon {
  const size = focused ? 34 : 28;
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.28);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const USER_ICON = L.divIcon({
  className: '',
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#0b6efd;border:3px solid #fff;box-shadow:0 0 0 5px rgba(11,110,253,0.25);"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

function RecenterOnce({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    map.flyTo([lat, lon], 15, { duration: 0.6 });
  }, [lat, lon, map]);
  return null;
}

export function StationMap({
  stations,
  focusedId,
  onFocusStation,
  userLocation,
}: {
  stations: NearbyStation[];
  focusedId: string | null;
  onFocusStation: (id: string) => void;
  userLocation: { lat: number; lon: number } | null;
}) {
  return (
    <MapContainer
      center={userLocation ? [userLocation.lat, userLocation.lon] : DEFAULT_CENTER}
      zoom={14}
      zoomControl={false}
      attributionControl={true}
      style={{ position: 'absolute', inset: 0 }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      {userLocation && (
        <>
          <Marker position={[userLocation.lat, userLocation.lon]} icon={USER_ICON} />
          <RecenterOnce lat={userLocation.lat} lon={userLocation.lon} />
        </>
      )}
      {stations.map((st) => (
        <Marker
          key={st.id}
          position={[st.lat, st.lon]}
          icon={stationIcon(st.lines[0]?.color ?? '#0039A6', st.id === focusedId)}
          eventHandlers={{ click: () => onFocusStation(st.id) }}
        >
          {st.id === focusedId && (
            <Tooltip permanent direction="top" offset={[0, -20]} className="station-label-tooltip">
              {st.name}
            </Tooltip>
          )}
        </Marker>
      ))}
    </MapContainer>
  );
}
