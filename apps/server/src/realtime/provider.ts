import { DATA_SOURCE } from '../config.js';
import { MockRealtimeProvider } from './mockProvider.js';
import { MtaGtfsRealtimeProvider } from './mtaProvider.js';
import type { RealtimeProvider } from './types.js';

let instance: RealtimeProvider | null = null;

/** A warm serverless instance reuses this singleton; a cold start creates a fresh one. */
export function getRealtimeProvider(): RealtimeProvider {
  if (!instance) {
    instance = DATA_SOURCE === 'mta' ? new MtaGtfsRealtimeProvider() : new MockRealtimeProvider();
  }
  return instance;
}
