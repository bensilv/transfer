# Transit server

Backend for the transit transfer app. Serves nearby-station arrivals and
per-trip journeys (remaining stops + connecting-line transfer times) over a
small REST API.

Deployed to Vercel, this runs as a serverless function (see root `vercel.json`)
— every request fetches fresh data on demand rather than relying on a
background process, since serverless functions don't have one. Locally it
also runs as a normal long-lived Express server via `npm run dev`.

## Running

```
cp .env.example .env   # optional, defaults are fine for local dev
npm install
npm run dev
```

Listens on `http://localhost:8787` by default. Needs live network access to
MTA's public GTFS-RT feeds (`src/realtime/mtaProvider.ts`) — no API key
required, but there's no offline/mock fallback.

## Coverage

Covers every subway (and Staten Island Railway) station complex system-wide,
generated from MTA's official "MTA Subway Stations and Complexes" open
dataset (`src/data/stations.ts` — see the header comment there). Real GTFS
stop IDs come straight from that dataset, so there's no coordinate-matching
or guessing involved (`src/data/gtfsStatic.ts` just looks them up).

Re-run `npx tsx scripts/generate-stations.ts` to refresh `stations.ts` if MTA
adds/renames a station — this isn't part of the build, since the data rarely
changes.

## API

- `GET /api/health` — `{ serverTime }`
- `GET /api/stations` — static station list (id, name, lat/lon, lines)
- `GET /api/stations/nearby?direction=downtown|uptown&lat=&lon=&limit=` —
  Screen 1 data: the `limit` (default 15, max 100) stations nearest to
  `lat`/`lon` (defaults to a fixed Manhattan reference point if omitted),
  each with per-line upcoming arrivals in that direction
- `GET /api/journey?tripId=&line=&direction=&boardedStationId=&boardedArrivalMs=`
  — Screen 2 / transfer-preview data: the remaining stops after the boarding
  stop, with each stop's connecting-line transfer options

Each response includes a `status: { online, lastErrorMessage }` reflecting
whether *that specific request's* upstream MTA fetch succeeded.
