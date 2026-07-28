import { useState } from 'react';
import type { ActiveTrip, Direction } from './types';
import { HomeScreen } from './screens/HomeScreen';
import { JourneyScreen } from './screens/JourneyScreen';

type Screen = 'home' | 'journey';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [homeDirection, setHomeDirection] = useState<Direction>('downtown');
  const [focusedStationId, setFocusedStationId] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveTrip | null>(null);
  const [preview, setPreview] = useState<ActiveTrip | null>(null);

  const selectArrival = (trip: ActiveTrip) => {
    setActive(trip);
    setPreview(null);
    setScreen('journey');
  };

  const previewTransfer = (trip: ActiveTrip) => setPreview(trip);
  const cancelPreview = () => setPreview(null);
  const confirmPreview = () => {
    if (!preview) return;
    setActive(preview);
    setPreview(null);
  };
  const goHome = () => {
    setScreen('home');
    setActive(null);
    setPreview(null);
  };

  return (
    <div style={{ position: 'relative', height: '100dvh', width: '100%', overflow: 'hidden', background: '#fff' }}>
      {screen === 'home' && (
        <HomeScreen
          direction={homeDirection}
          onSetDirection={setHomeDirection}
          focusedStationId={focusedStationId}
          onFocusStation={setFocusedStationId}
          onSelectArrival={selectArrival}
        />
      )}
      {screen === 'journey' && active && (
        <JourneyScreen
          active={active}
          preview={preview}
          onPreviewTransfer={previewTransfer}
          onCancelPreview={cancelPreview}
          onConfirmPreview={confirmPreview}
          onGoHome={goHome}
        />
      )}
    </div>
  );
}
