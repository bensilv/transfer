// Official MTA subway line colors (same palette used in the Claude Design mockup).
export const LINE_COLORS: Record<string, string> = {
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
  '4': '#00933C', '5': '#00933C', '6': '#00933C',
  '7': '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6',
  B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45',
  J: '#996633', Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  S: '#808183',
};

export const LIGHT_TEXT_LINES = new Set(['N', 'Q', 'R', 'W', 'L']);

export function textColorFor(line: string): string {
  return LIGHT_TEXT_LINES.has(line) ? '#1a1a1a' : '#fff';
}

// Which GTFS-RT feed group a route belongs to. MTA publishes one protobuf feed
// per group rather than one feed per route.
// https://api.mta.info/#/subwayRealTimeFeeds
export const FEED_GROUP_FOR_ROUTE: Record<string, string> = {
  '1': '1234567', '2': '1234567', '3': '1234567', '4': '1234567',
  '5': '1234567', '6': '1234567', '7': '1234567', S: '1234567',
  A: 'ace', C: 'ace', E: 'ace',
  B: 'bdfm', D: 'bdfm', F: 'bdfm', M: 'bdfm',
  G: 'g',
  J: 'jz', Z: 'jz',
  L: 'l',
  N: 'nqrw', Q: 'nqrw', R: 'nqrw', W: 'nqrw',
};

export const FEED_GROUPS = Array.from(new Set(Object.values(FEED_GROUP_FOR_ROUTE)));
