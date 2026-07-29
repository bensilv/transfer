export const PORT = Number(process.env.PORT ?? 8787);

/**
 * "mta" (default): fetches the real public MTA GTFS-RT feeds on demand, per request.
 * "mock": deterministic generated data, works with no network access.
 */
export const DATA_SOURCE = (process.env.DATA_SOURCE ?? 'mta') as 'mock' | 'mta';
