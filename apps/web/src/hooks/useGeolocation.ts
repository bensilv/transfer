import { useEffect, useState } from 'react';

export interface GeoState {
  lat: number | null;
  lon: number | null;
  /** true once we've heard back from the browser (granted, denied, or unsupported). */
  settled: boolean;
  denied: boolean;
}

/** BRD requires the home map to center on the user's real location (permission required). */
export function useGeolocation(): GeoState {
  const [state, setState] = useState<GeoState>({ lat: null, lon: null, settled: false, denied: false });

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setState({ lat: null, lon: null, settled: true, denied: false });
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => setState({ lat: pos.coords.latitude, lon: pos.coords.longitude, settled: true, denied: false }),
      () => setState((s) => ({ ...s, settled: true, denied: true })),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return state;
}
