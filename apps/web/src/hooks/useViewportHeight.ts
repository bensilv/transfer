import { useEffect, useState } from 'react';

/** Reactive `window.innerHeight` — used to size bottom-sheet snap points (e.g. "78% of the screen") against the actual viewport instead of a value baked in at first render. */
export function useViewportHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return height;
}
