import { useState } from 'react';
import type { ActiveTrip, Direction, JourneyLeg, StationAnchor } from './types';
import { HomeScreen } from './screens/HomeScreen';
import { JourneyScreen } from './screens/JourneyScreen';

export default function App() {
  const [legs, setLegs] = useState<JourneyLeg[]>([]);
  const [preview, setPreview] = useState<ActiveTrip | null>(null);
  const [stationAnchor, setStationAnchor] = useState<StationAnchor | null>(null);

  // Shared direction + focus state persists across screen transitions.
  const [homeDirection, setHomeDirection] = useState<Direction>('downtown');
  const [focusedStationId, setFocusedStationId] = useState<string | null>(null);

  // ── Home screen: start the first leg ─────────────────────────────────────
  const selectArrival = (trip: ActiveTrip) => {
    setLegs([trip]);
    setPreview(null);
    setStationAnchor(null);
  };

  // ── Station screen: add the next leg ─────────────────────────────────────
  const addLeg = (trip: ActiveTrip) => {
    setLegs((prev) => [...prev, trip]);
    setPreview(null);
    setStationAnchor(null);
  };

  // ── Journey screen: quick transfer preview / confirm ──────────────────────
  const previewTransfer = (trip: ActiveTrip) => setPreview(trip);
  const cancelPreview = () => setPreview(null);
  const confirmPreview = () => {
    if (!preview) return;
    addLeg(preview);
  };

  // ── Journey screen: tap a stop → open station-selection screen ────────────
  const alightAt = (stationId: string, lat: number, lon: number, routePoints: [number, number][]) => {
    // Freeze the current leg's route so the station screen can draw it.
    setLegs((prev) => {
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], routePoints };
      return updated;
    });
    setPreview(null);
    setStationAnchor({ stationId, lat, lon });
  };

  // ── Station screen: back without choosing a train ─────────────────────────
  const backToJourney = () => setStationAnchor(null);

  // ── Journey screen: close everything ─────────────────────────────────────
  const goHome = () => {
    setLegs([]);
    setPreview(null);
    setStationAnchor(null);
  };

  const currentLeg = legs[legs.length - 1] ?? null;
  const previousLegs = legs.length > 1 ? legs.slice(0, -1) : [];

  return (
    <div style={{ position: 'relative', height: '100dvh', width: '100%', overflow: 'hidden', background: '#fff' }}>
      {legs.length === 0 && (
        <HomeScreen
          direction={homeDirection}
          onSetDirection={setHomeDirection}
          focusedStationId={focusedStationId}
          onFocusStation={setFocusedStationId}
          onSelectArrival={selectArrival}
        />
      )}

      {legs.length > 0 && !stationAnchor && currentLeg && (
        <JourneyScreen
          active={currentLeg}
          previousLegs={previousLegs}
          preview={preview}
          onPreviewTransfer={previewTransfer}
          onCancelPreview={cancelPreview}
          onConfirmPreview={confirmPreview}
          onAlightAt={alightAt}
          onGoHome={goHome}
        />
      )}

      {legs.length > 0 && stationAnchor && (
        <HomeScreen
          direction={homeDirection}
          onSetDirection={setHomeDirection}
          focusedStationId={focusedStationId}
          onFocusStation={setFocusedStationId}
          onSelectArrival={addLeg}
          anchor={stationAnchor}
          previousLegs={legs}
          onBack={backToJourney}
        />
      )}
    </div>
  );
}
