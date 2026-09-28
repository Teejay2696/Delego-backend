/**
 * Carrier Tracking Polling Fallback for Non-Webhook Carriers (Issue #384)
 *
 * Periodically polls carrier tracking APIs for orders whose carrier does not
 * support webhooks.  Uses an exponential backoff schedule: the poll interval
 * is doubled after every consecutive check that returns no status change,
 * capped at MAX_POLL_INTERVAL_MINUTES.
 *
 * Polling state (`nextPollAt`, `pollIntervalMinutes`, `consecutiveUnchangedCount`)
 * is persisted in the `payment_records` table so a process restart never loses
 * backoff progress.
 *
 * When a status change is detected the new status is written back to the
 * `payment_records` table and a `carrier_tracking_updated` event is emitted
 * to the internal domain event bus.
 *
 * Scope: apps/backend/payments/src/workers/carrierPolling.ts
 */

import { createLogger } from "@delegolabs/utils";
import { Pool } from "pg";
import type { PollingSchedule } from "@delegolabs/types";

const log = createLogger("payments:workers:carrierPolling", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum initial polling interval when no override is configured. */
const DEFAULT_INITIAL_POLL_INTERVAL_MINUTES = Number(
  process.env.CARRIER_POLL_INITIAL_INTERVAL_MINUTES ?? 5
);

/** Absolute ceiling on the backoff interval to prevent polling from stopping
 *  entirely on very stale orders. */
const MAX_POLL_INTERVAL_MINUTES = Number(
  process.env.CARRIER_POLL_MAX_INTERVAL_MINUTES ?? 1440 // 24 hours
);

/** How many consecutive unchanged polls trigger the backoff doubling. */
const UNCHANGED_THRESHOLD = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Carriers that support webhooks — polling is skipped for these. */
export type WebhookSupportedCarrier = string;

/** Subset of payment_records columns relevant to carrier polling. */
export interface CarrierPollTarget {
  paymentId: string;
  orderId: string;
  trackingNumber: string;
  carrier: string;
  currentTrackingStatus: string | null;
  nextPollAt: Date;
  pollIntervalMinutes: number;
  consecutiveUnchangedCount: number;
}

/** Raw tracking data returned by a carrier adapter. */
export interface TrackingStatus {
  status: string;
  description?: string;
  estimatedDelivery?: string;
  location?: string;
  timestamp: string;
}

/** Outcome of processing a single poll target. */
export interface CarrierPollResult {
  paymentId: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  status: "updated" | "unchanged" | "error" | "skipped";
  previousStatus?: string | null;
  newStatus?: string;
  reason?: string;
}

/** Aggregated result for one full sweep. */
export interface CarrierPollSweepResult {
  checked: number;
  updated: number;
  unchanged: number;
  errors: number;
  skipped: number;
  results: CarrierPollResult[];
}

// ---------------------------------------------------------------------------
// Carrier adapter interface
// ---------------------------------------------------------------------------

/**
 * Injectable carrier adapter.  Each carrier (FedEx, UPS, USPS, …) provides
 * its own implementation.  The default implementation calls
 * `CARRIER_TRACKING_SERVICE_URL` as a unified tracking micro-service.
 */
export interface CarrierAdapter {
  /** Returns true when the carrier natively supports webhook push delivery. */
  supportsWebhooks(carrier: string): boolean;
  /** Fetches the latest tracking status for a shipment. */
  fetchTrackingStatus(carrier: string, trackingNumber: string): Promise<TrackingStatus>;
}

/** Default adapter that delegates to a configurable tracking service URL. */
export class DefaultCarrierAdapter implements CarrierAdapter {
  private readonly serviceUrl: string;
  private readonly webhookCarriers: Set<string>;

  constructor(options?: {
    serviceUrl?: string;
    webhookSupportedCarriers?: string[];
  }) {
    this.serviceUrl =
      options?.serviceUrl ??
      process.env.CARRIER_TRACKING_SERVICE_URL ??
      "";

    const envCarriers = process.env.WEBHOOK_SUPPORTED_CARRIERS?.split(",").map((c) =>
      c.trim().toLowerCase()
    ) ?? [];
    const cfgCarriers =
      options?.webhookSupportedCarriers?.map((c) => c.toLowerCase()) ?? [];
    this.webhookCarriers = new Set([...envCarriers, ...cfgCarriers]);
  }

  supportsWebhooks(carrier: string): boolean {
    return this.webhookCarriers.has(carrier.toLowerCase());
  }

  async fetchTrackingStatus(
    carrier: string,
    trackingNumber: string
  ): Promise<TrackingStatus> {
    if (!this.serviceUrl) {
      throw new Error(
        "CARRIER_TRACKING_SERVICE_URL is not configured; cannot fetch tracking status"
      );
    }

    const url = `${this.serviceUrl}/track?carrier=${encodeURIComponent(carrier)}&number=${encodeURIComponent(trackingNumber)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(
        `Carrier tracking service returned ${res.status} for ${carrier}/${trackingNumber}`
      );
    }

    const body = (await res.json()) as Partial<TrackingStatus>;

    if (!body.status || !body.timestamp) {
      throw new Error(
        `Unexpected tracking response shape from carrier service for ${carrier}/${trackingNumber}`
      );
    }

    return {
      status: body.status,
      description: body.description,
      estimatedDelivery: body.estimatedDelivery,
      location: body.location,
      timestamp: body.timestamp,
    };
  }
}

let defaultAdapter: CarrierAdapter | null = null;

function getCarrierAdapter(): CarrierAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new DefaultCarrierAdapter();
  }
  return defaultAdapter;
}

/** Override the default adapter — useful for unit tests. */
export function _setCarrierAdapterForTesting(adapter: CarrierAdapter): void {
  defaultAdapter = adapter;
}

export function _resetCarrierAdapterForTesting(): void {
  defaultAdapter = null;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ??
        "postgresql://delego:delego@localhost:5432/delego",
    });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

/**
 * Finds all payment_records that:
 *  - have a tracking_number and carrier set
 *  - are not yet terminal (status != 'delivered' / 'released' / 'refunded')
 *  - have next_poll_at <= now (or next_poll_at is NULL, i.e. first-time poll)
 *
 * The polling metadata columns (`next_poll_at`, `poll_interval_minutes`,
 * `consecutive_unchanged_count`) are expected to exist on the
 * `payment_records` table.  If they are absent, the migration that adds them
 * must be run first (see database/migrations/).
 */
export async function findPollTargets(): Promise<CarrierPollTarget[]> {
  const db = getPool();

  const { rows } = await db.query<{
    id: string;
    order_id: string;
    tracking_number: string;
    carrier: string;
    tracking_status: string | null;
    next_poll_at: Date | null;
    poll_interval_minutes: number | null;
    consecutive_unchanged_count: number | null;
  }>(
    `SELECT
       id,
       order_id,
       tracking_number,
       carrier,
       tracking_status,
       next_poll_at,
       poll_interval_minutes,
       consecutive_unchanged_count
     FROM payment_records
     WHERE tracking_number IS NOT NULL
       AND carrier         IS NOT NULL
       AND status NOT IN ('released', 'refunded', 'failed')
       AND (
             next_poll_at IS NULL
          OR next_poll_at <= NOW()
       )
     ORDER BY next_poll_at ASC NULLS FIRST`
  );

  return rows.map((row) => ({
    paymentId: row.id,
    orderId: row.order_id,
    trackingNumber: row.tracking_number,
    carrier: row.carrier,
    currentTrackingStatus: row.tracking_status ?? null,
    nextPollAt: row.next_poll_at ?? new Date(0),
    pollIntervalMinutes:
      row.poll_interval_minutes ?? DEFAULT_INITIAL_POLL_INTERVAL_MINUTES,
    consecutiveUnchangedCount: row.consecutive_unchanged_count ?? 0,
  }));
}

/**
 * Persists the new tracking status and updated PollingSchedule back to the
 * `payment_records` table.
 */
export async function updateTrackingStatus(
  paymentId: string,
  newStatus: string,
  schedule: PollingSchedule
): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE payment_records
     SET tracking_status             = $1,
         next_poll_at                = $2,
         poll_interval_minutes       = $3,
         consecutive_unchanged_count = $4,
         updated_at                  = NOW()
     WHERE id = $5`,
    [
      newStatus,
      schedule.nextPollAt,
      schedule.pollIntervalMinutes,
      schedule.consecutiveUnchangedCount,
      paymentId,
    ]
  );
}

/**
 * Persists only the PollingSchedule (no status change) back to
 * `payment_records`.  Used when a poll returns the same status.
 */
export async function updatePollingSchedule(
  paymentId: string,
  schedule: PollingSchedule
): Promise<void> {
  const db = getPool();

  await db.query(
    `UPDATE payment_records
     SET next_poll_at                = $1,
         poll_interval_minutes       = $2,
         consecutive_unchanged_count = $3,
         updated_at                  = NOW()
     WHERE id = $4`,
    [
      schedule.nextPollAt,
      schedule.pollIntervalMinutes,
      schedule.consecutiveUnchangedCount,
      paymentId,
    ]
  );
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

/**
 * Computes the next PollingSchedule after a poll that returned no status change.
 *
 * The interval is doubled once `UNCHANGED_THRESHOLD` consecutive unchanged
 * polls have been observed, capped at `MAX_POLL_INTERVAL_MINUTES`.
 */
export function computeNextSchedule(
  current: PollingSchedule,
  changed: boolean
): PollingSchedule {
  if (changed) {
    // Status changed — reset backoff to the initial interval.
    const resetInterval = DEFAULT_INITIAL_POLL_INTERVAL_MINUTES;
    return {
      nextPollAt: new Date(Date.now() + resetInterval * 60 * 1_000),
      pollIntervalMinutes: resetInterval,
      consecutiveUnchangedCount: 0,
    };
  }

  // No change — increment the unchanged counter and potentially double interval.
  const newUnchangedCount = current.consecutiveUnchangedCount + 1;
  let newInterval = current.pollIntervalMinutes;

  if (newUnchangedCount % UNCHANGED_THRESHOLD === 0) {
    newInterval = Math.min(current.pollIntervalMinutes * 2, MAX_POLL_INTERVAL_MINUTES);
  }

  return {
    nextPollAt: new Date(Date.now() + newInterval * 60 * 1_000),
    pollIntervalMinutes: newInterval,
    consecutiveUnchangedCount: newUnchangedCount,
  };
}

// ---------------------------------------------------------------------------
// Domain event emission
// ---------------------------------------------------------------------------

/**
 * Emits a `carrier_tracking_updated` domain event to the payments event bus.
 * This is a best-effort fire-and-forget call — failures are logged but not
 * allowed to abort the tracking update itself.
 */
export async function emitTrackingUpdatedEvent(
  paymentId: string,
  orderId: string,
  carrier: string,
  trackingNumber: string,
  previousStatus: string | null,
  newStatus: string
): Promise<void> {
  try {
    const eventsUrl =
      process.env.PAYMENTS_EVENTS_URL ??
      process.env.EVENT_BUS_URL ??
      "";

    if (!eventsUrl) {
      // No event bus configured — log only.
      log.info("carrier_tracking_updated (no event bus configured)", {
        paymentId,
        orderId,
        carrier,
        trackingNumber,
        previousStatus,
        newStatus,
      });
      return;
    }

    const res = await fetch(`${eventsUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "carrier_tracking_updated",
        occurredAt: new Date().toISOString(),
        payload: {
          paymentId,
          orderId,
          carrier,
          trackingNumber,
          previousStatus,
          newStatus,
        },
      }),
    });

    if (!res.ok) {
      log.warn("Failed to emit carrier_tracking_updated event", {
        paymentId,
        status: res.status,
      });
    }
  } catch (err) {
    log.warn("Error emitting carrier_tracking_updated event", {
      paymentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Single target processing
// ---------------------------------------------------------------------------

/**
 * Polls the carrier for a single `target` and writes back any changes.
 */
export async function processPollTarget(
  target: CarrierPollTarget,
  adapter?: CarrierAdapter
): Promise<CarrierPollResult> {
  const carrierAdapter = adapter ?? getCarrierAdapter();

  // Skip carriers that support webhooks — they push updates proactively.
  if (carrierAdapter.supportsWebhooks(target.carrier)) {
    log.debug("Skipping carrier with webhook support", {
      carrier: target.carrier,
      paymentId: target.paymentId,
    });
    return {
      paymentId: target.paymentId,
      orderId: target.orderId,
      carrier: target.carrier,
      trackingNumber: target.trackingNumber,
      status: "skipped",
      reason: `${target.carrier} supports webhooks; polling not required`,
    };
  }

  let tracking: TrackingStatus;
  try {
    tracking = await carrierAdapter.fetchTrackingStatus(
      target.carrier,
      target.trackingNumber
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to fetch carrier tracking status", {
      paymentId: target.paymentId,
      carrier: target.carrier,
      trackingNumber: target.trackingNumber,
      error: message,
    });

    // Advance the schedule even on error so we don't tight-loop.
    const currentSchedule: PollingSchedule = {
      nextPollAt: target.nextPollAt,
      pollIntervalMinutes: target.pollIntervalMinutes,
      consecutiveUnchangedCount: target.consecutiveUnchangedCount,
    };
    const nextSchedule = computeNextSchedule(currentSchedule, false);

    await updatePollingSchedule(target.paymentId, nextSchedule).catch((dbErr) => {
      log.warn("Could not update polling schedule after fetch error", {
        paymentId: target.paymentId,
        error: (dbErr as Error).message,
      });
    });

    return {
      paymentId: target.paymentId,
      orderId: target.orderId,
      carrier: target.carrier,
      trackingNumber: target.trackingNumber,
      status: "error",
      reason: message,
    };
  }

  const currentSchedule: PollingSchedule = {
    nextPollAt: target.nextPollAt,
    pollIntervalMinutes: target.pollIntervalMinutes,
    consecutiveUnchangedCount: target.consecutiveUnchangedCount,
  };

  const changed = tracking.status !== target.currentTrackingStatus;
  const nextSchedule = computeNextSchedule(currentSchedule, changed);

  if (changed) {
    log.info("Carrier tracking status changed", {
      paymentId: target.paymentId,
      orderId: target.orderId,
      carrier: target.carrier,
      trackingNumber: target.trackingNumber,
      previousStatus: target.currentTrackingStatus,
      newStatus: tracking.status,
      nextPollAt: nextSchedule.nextPollAt.toISOString(),
    });

    await updateTrackingStatus(target.paymentId, tracking.status, nextSchedule);

    // Fire-and-forget domain event.
    void emitTrackingUpdatedEvent(
      target.paymentId,
      target.orderId,
      target.carrier,
      target.trackingNumber,
      target.currentTrackingStatus,
      tracking.status
    );

    return {
      paymentId: target.paymentId,
      orderId: target.orderId,
      carrier: target.carrier,
      trackingNumber: target.trackingNumber,
      status: "updated",
      previousStatus: target.currentTrackingStatus,
      newStatus: tracking.status,
    };
  }

  // No change — persist updated schedule.
  log.debug("Carrier tracking status unchanged", {
    paymentId: target.paymentId,
    carrier: target.carrier,
    trackingNumber: target.trackingNumber,
    currentStatus: target.currentTrackingStatus,
    nextPollAt: nextSchedule.nextPollAt.toISOString(),
    consecutiveUnchangedCount: nextSchedule.consecutiveUnchangedCount,
  });

  await updatePollingSchedule(target.paymentId, nextSchedule);

  return {
    paymentId: target.paymentId,
    orderId: target.orderId,
    carrier: target.carrier,
    trackingNumber: target.trackingNumber,
    status: "unchanged",
    previousStatus: target.currentTrackingStatus,
    newStatus: tracking.status,
  };
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

/**
 * Runs a full carrier polling sweep: finds all due targets, polls each one,
 * and writes back any status changes.
 */
export async function runCarrierPollingSweep(
  adapter?: CarrierAdapter
): Promise<CarrierPollSweepResult> {
  log.info("Starting carrier polling sweep");

  const targets = await findPollTargets();
  log.info("Found carrier poll targets", { count: targets.length });

  const results: CarrierPollResult[] = [];
  let updated = 0;
  let unchanged = 0;
  let errors = 0;
  let skipped = 0;

  for (const target of targets) {
    const result = await processPollTarget(target, adapter);
    results.push(result);

    switch (result.status) {
      case "updated":
        updated++;
        break;
      case "unchanged":
        unchanged++;
        break;
      case "error":
        errors++;
        break;
      case "skipped":
        skipped++;
        break;
    }
  }

  const sweepResult: CarrierPollSweepResult = {
    checked: targets.length,
    updated,
    unchanged,
    errors,
    skipped,
    results,
  };

  log.info("Carrier polling sweep complete", {
    checked: sweepResult.checked,
    updated: sweepResult.updated,
    unchanged: sweepResult.unchanged,
    errors: sweepResult.errors,
    skipped: sweepResult.skipped,
  });

  return sweepResult;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface CarrierPollingSchedulerHandle {
  stop(): void;
}

/**
 * Starts a recurring carrier tracking polling sweep.
 *
 * The scheduler interval controls how often due targets are checked — NOT
 * the per-carrier poll frequency (which is governed by `nextPollAt`).
 *
 * Defaults to every 60 seconds; configurable via:
 *   CARRIER_POLL_SCHEDULER_INTERVAL_SECONDS  (e.g. 60)
 *
 * Set to "0" to disable the scheduler (useful in worker-only deployments
 * that trigger sweeps on demand).
 */
export function startCarrierPollingScheduler(
  adapter?: CarrierAdapter
): CarrierPollingSchedulerHandle {
  const intervalSeconds = parseInt(
    process.env.CARRIER_POLL_SCHEDULER_INTERVAL_SECONDS ?? "60",
    10
  );

  if (intervalSeconds <= 0) {
    log.info("Carrier polling scheduler disabled (CARRIER_POLL_SCHEDULER_INTERVAL_SECONDS=0)");
    return { stop: () => {} };
  }

  log.info("Starting carrier polling scheduler", { intervalSeconds });

  // Run one sweep immediately on startup, then on each interval tick.
  void runCarrierPollingSweep(adapter).catch((err) => {
    log.error("Initial carrier polling sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const timer = setInterval(() => {
    void runCarrierPollingSweep(adapter).catch((err) => {
      log.error("Carrier polling sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalSeconds * 1_000);

  // Don't keep the process alive solely for this timer.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      log.info("Carrier polling scheduler stopped");
    },
  };
}
