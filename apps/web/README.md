# Transit web app

React + Vite mobile-responsive frontend implementing the two screens from
the Claude Design mockup (`project/Transit App.dc.html`):

- **Home** — live map (react-leaflet/OpenStreetMap) with a bottom sheet:
  the focused station's lines + horizontally-scrollable upcoming arrivals,
  a single Downtown/Uptown switcher, and a horizontal station-card picker.
- **Journey** — the boarded train's remaining stops, each with connecting
  transfer options; tapping a transfer previews that line (back chevron +
  floating "Transfer →" to confirm), tapping ✕ exits to Home.

No native app chrome (status bar/bezel) — this targets a real mobile browser,
per the BRD's "mobile-responsive website" v1 scope.

## Running

```
npm install
npm run dev
```

Needs the server running too (see `../server`). In local dev it defaults to
`http://localhost:8787` (override with `VITE_API_BASE_URL`); in a production
build it defaults to same-origin `/api/*` (see `../../vercel.json` — both
apps deploy to the same domain, so no URL needs configuring there).

## Notes

- Requests location permission on load to center the map (BRD requirement);
  falls back to a default Manhattan center if denied/unsupported.
- Polls the backend every 20s. If a request fails, the last successful data
  keeps displaying and countdowns keep ticking down off the real arrival
  timestamps (rather than freezing) — with arrival/transfer text switching to
  italic + muted and a leading "~", and the header status dot flipping to red
  — matching the BRD's offline/degraded-connectivity behavior.
- Map tiles come from the public OpenStreetMap tile servers; this sandbox's
  network policy blocks that host, so tiles render blank/gray here — station
  markers, the sheet, and all interactions are unaffected, and it renders
  normal map tiles in a normal network environment.
