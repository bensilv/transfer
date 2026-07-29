import { useEffect, useState } from 'react';

export interface GeoState {
  lat: number | null;
  lon: number | null;
  /** Reported fix radius in meters (coords.accuracy) — smaller is better. Early
   * watchPosition callbacks are often a coarse network/cell fix that arrives
   * before the GPS chip locks on, so callers that need a trustworthy initial
   * fix (e.g. the map's one-time recenter) should factor this in rather than
   * just taking whatever lat/lon showed up first. */
  accuracy: number | null;
  /** true once we've heard back from the browser (granted, denied, or unsupported). */
  settled: boolean;
  denied: boolean;
}

const INITIAL_STATE: GeoState = { lat: null, lon: null, accuracy: null, settled: false, denied: false };

/** BRD requires the home map to center on the user's real location (permission required). */
export function useGeolocation(): GeoState {
  const [state, setState] = useState<GeoState>(INITIAL_STATE);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setState({ ...INITIAL_STATE, settled: true });
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) =>
        setState({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          settled: true,
          denied: false,
        }),
      () => setState((s) => ({ ...s, settled: true, denied: true })),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return state;
}
