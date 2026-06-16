import type {
  ScaleAdapter,
  BleDeviceInfo,
  UserProfile,
  ScaleAuth,
} from '../../interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../config/schema.js';
import { type RawReading, waitForRawReading } from '../shared.js';
import { evaluateAdvertisement, GraceTimers, DedupWindow } from '../advertisement.js';
import { bleLog, errMsg, IMPEDANCE_GRACE_MS } from '../types.js';
import { AsyncQueue } from '../async-queue.js';
import { EsphomeProxyPool } from './pool.js';
import { logTransportCapabilities } from './scan.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 30_000;
// Cap for the "already warned about this scale's GATT failure" tracker. Old
// entries are evicted LRU-style so dedup persists long-term in continuous mode.
const GATT_WARN_LRU_MAX = 256;

// ─── ReadingWatcher (continuous mode) ────────────────────────────────────────

/**
 * Persistent event-driven watcher for continuous mode over an ESPHome proxy
 * pool. Broadcast scales parse from advertisements; GATT scales are connected
 * on demand through the proxy that last saw them and read via the shared
 * waitForRawReading() seam, then disconnected immediately so no proxy slot is
 * held between weigh-ins.
 */
export class ReadingWatcher {
  private queue = new AsyncQueue<RawReading>();
  private started = false;
  private adapters: ScaleAdapter[];
  private targetMac?: string;
  private profile?: UserProfile;
  private scaleAuth?: ScaleAuth;
  private config: EsphomeProxyConfig;
  private readonly dedup = new DedupWindow(DEDUP_WINDOW_MS);
  private pool: EsphomeProxyPool | null = null;
  private unsub: (() => void) | null = null;
  private gattInFlight = new Set<string>();
  // LRU map (insertion-ordered): scales whose on-demand GATT connect failed,
  // so we warn once instead of on every advertisement.
  private gattWarnedFor = new Map<string, true>();
  /** Weight-only fallback timer per address; on elapse the held reading is
   *  queued directly (no dedup — matches the prior grace-timer body). */
  private readonly grace = new GraceTimers(IMPEDANCE_GRACE_MS, (address, gr) => {
    bleLog.info(
      `Matched: ${gr.adapter.name} (${address}), weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s`,
    );
    bleLog.info(`Broadcast reading: ${gr.reading.weight} kg`);
    this.queue.push(gr);
  });

  constructor(
    config: EsphomeProxyConfig,
    adapters: ScaleAdapter[],
    targetMac?: string,
    profile?: UserProfile,
    scaleAuth?: ScaleAuth,
  ) {
    this.config = config;
    this.adapters = adapters;
    this.targetMac = targetMac?.toLowerCase();
    this.profile = profile;
    this.scaleAuth = scaleAuth;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.pool = new EsphomeProxyPool(this.config);
      await this.pool.start();
      logTransportCapabilities(this.adapters);
      this.unsub = this.pool.onAdvertisement((info, mac) => this.handleAd(info, mac));
      bleLog.info('ESPHome ReadingWatcher started, listening for advertisements');
    } catch (err) {
      this.started = false;
      await this.teardown();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.teardown();
    this.started = false;
    bleLog.info('ESPHome ReadingWatcher stopped');
  }

  nextReading(signal?: AbortSignal): Promise<RawReading> {
    return this.queue.shift(signal);
  }

  updateConfig(
    adapters: ScaleAdapter[],
    targetMac?: string,
    profile?: UserProfile,
    scaleAuth?: ScaleAuth,
  ): void {
    this.adapters = adapters;
    this.targetMac = targetMac?.toLowerCase();
    if (profile) this.profile = profile;
    if (scaleAuth) this.scaleAuth = scaleAuth;
  }

  private handleAd(info: BleDeviceInfo, address: string): void {
    const addrLc = address.toLowerCase();
    if (this.targetMac && addrLc !== this.targetMac) return;

    const adapter = this.adapters.find((a) => a.matches(info));
    if (!adapter) return;

    // waitForBroadcast:false — this watcher GATT-connects devices whose
    // broadcast yields nothing (QN Elis 1) from its per-advertisement stream
    // rather than waiting (see the hasParseableBroadcastSource doc comment).
    const decision = evaluateAdvertisement(adapter, info, { waitForBroadcast: false });

    if (decision.kind === 'complete') {
      this.grace.cancel(address);
      this.pushDeduped(address, { reading: decision.reading, adapter }, decision.reading.weight);
      return;
    }

    // Partial broadcast frame for a passive adapter: grace timer fallback.
    if (decision.kind === 'partial') {
      this.grace.hold(address, { reading: decision.reading, adapter });
      return;
    }

    // Broadcast yielded nothing usable. If the adapter has a GATT path, connect
    // on demand through the proxy pool. (decision is 'gatt' or 'none'.)
    if (decision.kind === 'gatt') {
      this.readViaGatt(adapter, address, addrLc);
    }
  }

  private pushDeduped(address: string, raw: RawReading, weight: number): void {
    if (!this.dedup.shouldEmit(address, weight)) {
      bleLog.debug(`Dedup skip: ${address}:${weight.toFixed(1)}`);
      return;
    }
    bleLog.info(`Matched: ${raw.adapter.name} (${address})`);
    bleLog.info(`Reading: ${weight} kg`);
    this.queue.push(raw);
  }

  private readViaGatt(adapter: ScaleAdapter, address: string, addrLc: string): void {
    if (this.gattInFlight.has(addrLc)) return;
    if (!this.pool) return;
    const pool = this.pool;
    this.gattInFlight.add(addrLc);
    bleLog.info(`Matched: ${adapter.name} (${address}); opening GATT via ESPHome proxy`);
    void (async () => {
      let session: Awaited<ReturnType<typeof pool.connectGatt>> | null = null;
      try {
        session = await pool.connectGatt(address);
        const raw = await waitForRawReading(
          session.charMap,
          session.device,
          adapter,
          this.profile ?? { height: 170, age: 30, gender: 'male', isAthlete: false },
          address.replace(/[:-]/g, '').toUpperCase(),
          undefined,
          undefined,
          this.scaleAuth,
        );
        this.pushDeduped(address, raw, raw.reading.weight);
      } catch (e) {
        this.warnGattFailure(adapter.name, address, errMsg(e));
      } finally {
        if (session) await session.close();
        this.gattInFlight.delete(addrLc);
      }
    })();
  }

  private warnGattFailure(adapterName: string, address: string, reason: string): void {
    if (this.gattWarnedFor.has(address)) {
      this.gattWarnedFor.delete(address);
      this.gattWarnedFor.set(address, true);
      return;
    }
    if (this.gattWarnedFor.size >= GATT_WARN_LRU_MAX) {
      const oldest = this.gattWarnedFor.keys().next().value;
      if (oldest !== undefined) this.gattWarnedFor.delete(oldest);
    }
    this.gattWarnedFor.set(address, true);
    bleLog.warn(
      `${adapterName} at ${address}: GATT read over the ESPHome proxy failed (${reason}). ` +
        `Will retry on the next advertisement.`,
    );
  }

  private async teardown(): Promise<void> {
    this.grace.clear();
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.pool) {
      await this.pool.stop();
      this.pool = null;
    }
  }
}
