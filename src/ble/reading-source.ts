import type { ScaleAdapter, UserProfile, ScaleAuth } from '../interfaces/scale-adapter.js';
import type { RawReading } from './shared.js';

/**
 * Config delivered to a {@link Watcher} on construction and on hot reload. The
 * shape is uniform across transports; a watcher ignores fields it does not use
 * (mqtt-proxy ignores `scaleAuth`). See #246.
 */
export interface WatcherConfig {
  adapters: ScaleAdapter[];
  targetMac?: string;
  profile?: UserProfile;
  scaleAuth?: ScaleAuth;
}

/**
 * Event-driven reading source for the proxy transports (mqtt-proxy,
 * esphome-proxy). Structurally a superset of the loop's `ReadingSource`
 * (start/stop/nextReading) plus a uniform `updateConfig` hot-reload hook, so a
 * single `createReadingSource` factory can return either a watcher or a poll
 * source and the orchestrator never branches on transport. See #246.
 */
export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  nextReading(signal?: AbortSignal): Promise<RawReading>;
  updateConfig(config: WatcherConfig): void;
}
