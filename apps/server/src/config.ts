export const PORT = Number(process.env.PORT ?? 8787);

/**
 * "mock" (default): deterministic generated data, works with no network access.
 * "mta": fetches the real public MTA GTFS-RT feeds on demand, per request.
 */
export const DATA_SOURCE = (process.env.DATA_SOURCE ?? 'mock') as 'mock' | 'mta';
