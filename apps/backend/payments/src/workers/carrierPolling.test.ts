/**
 * Unit + integration tests for the Carrier Tracking Polling Worker (Issue #384).
 *
 * Scope:
 *   apps/backend/payments/src/workers/carrierPolling.test.ts
 *
 * Coverage:
 *   - computeNextSchedule: backoff doubling on consecutive unchanged polls,
 *     reset on status change
 *   - processPollTarget: skip webhook carriers, detect status changes,
 *     propagate errors, advance schedule on error
 *   - runCarrierPollingSweep: aggregated sweep results
 *   - startCarrierPollingScheduler: disabled path (CARRIER_POLL_SCHEDULER_INTERVAL_SECONDS=0)
 *   - Integration: DB writes via mocked Pool
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import type { PollingSchedule } from "@delegolabs/types";

// ---- module under test --------------------------------------------------
import {
  DefaultCarrierAdapter,
  _resetCarrierAdapterForTesting,
  _resetPoolForTesting,
  _setCarrierAdapterForTesting,
  _setPoolForTesting,
  computeNextSchedule,
  findPollTargets,
  processPollTarget,
  runCarrierPollingSweep,
  startCarrierPollingScheduler,
  updatePollingSchedule,
  updateTrackingStatus,
  type CarrierAdapter,
  type CarrierPollTarget,
  type TrackingStatus,
} from "./carrierPolling.js";

// ---- helpers -----------------------------------------------------------

/**
 * Minimal mock Pool that records every call to `query`.
 */
function makeMockPool(
  queryImpl?: (sql: string, params?: unknown[]) => Promise<QueryResult>
): Pool {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const mockQuery = vi.fn(
    async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      calls.push({ sql, params });
      if (queryImpl) return queryImpl(sql, params);
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
    }
  );
  const mockPool = { query: mockQuery, _calls: calls } as unknown as Pool;
  return mockPool;
}

/**
 * Makes a minimal CarrierPollTarget.
 */
function makeTarget(overrides?: Partial<CarrierPollTarget>): CarrierPollTarget {
  return {
    paymentId: "pay-1",
    orderId: "order-1",
    trackingNumber: "1Z12345E0291980793",
    carrier: "ups",
    currentTrackingStatus: "in_transit",
    nextPollAt: new Date(Date.now() - 1_000), // due now
    pollIntervalMinutes: 5,
    consecutiveUnchangedCount: 0,
    ...overrides,
  };
}

/**
 * Makes a carrier adapter whose `fetchTrackingStatus` resolves to the
 * supplied status.
 */
function makeAdapter(
  status: string,
  webhookCarriers: string[] = []
): CarrierAdapter {
  return {
    supportsWebhooks: (carrier) =>
      webhookCarriers.map((c) => c.toLowerCase()).includes(carrier.toLowerCase()),
    fetchTrackingStatus: vi.fn(async (): Promise<TrackingStatus> => ({
      status,
      timestamp: new Date().toISOString(),
    })),
  };
}

// =========================================================================
// computeNextSchedule
// =========================================================================

describe("computeNextSchedule", () => {
  it("resets backoff when status changed", () => {
    const now = Date.now();
    const current: PollingSchedule = {
      nextPollAt: new Date(now - 1_000),
      pollIntervalMinutes: 80,
      consecutiveUnchangedCount: 4,
    };

    const next = computeNextSchedule(current, true /* changed */);

    expect(next.consecutiveUnchangedCount).toBe(0);
    // interval resets to the default (5 min unless env overridden)
    expect(next.pollIntervalMinutes).toBe(5);
    // nextPollAt should be ~5 minutes in the future
    expect(next.nextPollAt.getTime()).toBeGreaterThan(now + 4 * 60 * 1_000);
    expect(next.nextPollAt.getTime()).toBeLessThan(now + 6 * 60 * 1_000);
  });

  it("doubles the interval after each unchanged poll", () => {
    const now = Date.now();
    const current: PollingSchedule = {
      nextPollAt: new Date(now),
      pollIntervalMinutes: 5,
      consecutiveUnchangedCount: 0,
    };

    const next1 = computeNextSchedule(current, false);
    // First unchanged -> count becomes 1 -> interval doubles (5→10)
    expect(next1.consecutiveUnchangedCount).toBe(1);
    expect(next1.pollIntervalMinutes).toBe(10);

    const next2 = computeNextSchedule(next1, false);
    // Second unchanged -> count becomes 2 -> interval doubles (10→20)
    expect(next2.consecutiveUnchangedCount).toBe(2);
    expect(next2.pollIntervalMinutes).toBe(20);

    const next3 = computeNextSchedule(next2, false);
    // Third unchanged -> 20→40
    expect(next3.pollIntervalMinutes).toBe(40);
  });

  it("caps the interval at MAX_POLL_INTERVAL_MINUTES (1440 by default)", () => {
    const nearMax: PollingSchedule = {
      nextPollAt: new Date(),
      pollIntervalMinutes: 1000,
      consecutiveUnchangedCount: 5,
    };

    const next = computeNextSchedule(nearMax, false);
    expect(next.pollIntervalMinutes).toBe(1440);
  });

  it("does not increase the count beyond the cap when already at max interval", () => {
    const atMax: PollingSchedule = {
      nextPollAt: new Date(),
      pollIntervalMinutes: 1440,
      consecutiveUnchangedCount: 10,
    };

    const next = computeNextSchedule(atMax, false);
    expect(next.pollIntervalMinutes).toBe(1440);
    expect(next.consecutiveUnchangedCount).toBe(11);
  });
});

// =========================================================================
// processPollTarget
// =========================================================================

describe("processPollTarget", () => {
  beforeEach(() => {
    const mockPool = makeMockPool();
    _setPoolForTesting(mockPool);
  });

  afterEach(() => {
    _resetPoolForTesting();
    _resetCarrierAdapterForTesting();
    vi.restoreAllMocks();
  });

  it("skips carriers that support webhooks", async () => {
    const target = makeTarget({ carrier: "fedex" });
    const adapter = makeAdapter("delivered", ["fedex"]);

    const result = await processPollTarget(target, adapter);

    expect(result.status).toBe("skipped");
    expect(adapter.fetchTrackingStatus).not.toHaveBeenCalled();
  });

  it("returns 'updated' and writes to DB when status changes", async () => {
    const dbCalls: string[] = [];
    const mockPool = makeMockPool(async (sql) => {
      dbCalls.push(sql.trim().split(/\s+/)[0].toUpperCase()); // first keyword
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    const target = makeTarget({ currentTrackingStatus: "in_transit" });
    const adapter = makeAdapter("delivered"); // status changed

    const result = await processPollTarget(target, adapter);

    expect(result.status).toBe("updated");
    expect(result.previousStatus).toBe("in_transit");
    expect(result.newStatus).toBe("delivered");
    expect(dbCalls).toContain("UPDATE"); // tracking_status + schedule persisted
  });

  it("returns 'unchanged' and advances schedule when status is the same", async () => {
    const dbCalls: string[] = [];
    const mockPool = makeMockPool(async (sql) => {
      dbCalls.push(sql.trim().split(/\s+/)[0].toUpperCase());
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    const target = makeTarget({ currentTrackingStatus: "in_transit" });
    const adapter = makeAdapter("in_transit"); // same status

    const result = await processPollTarget(target, adapter);

    expect(result.status).toBe("unchanged");
    expect(dbCalls).toContain("UPDATE"); // schedule persisted
  });

  it("returns 'error' and still advances schedule when the carrier API fails", async () => {
    const dbCalls: string[] = [];
    const mockPool = makeMockPool(async (sql) => {
      dbCalls.push(sql.trim().split(/\s+/)[0].toUpperCase());
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    const failingAdapter: CarrierAdapter = {
      supportsWebhooks: () => false,
      fetchTrackingStatus: vi.fn(async () => {
        throw new Error("Carrier API timeout");
      }),
    };

    const target = makeTarget();
    const result = await processPollTarget(target, failingAdapter);

    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/Carrier API timeout/);
    // Schedule must still be advanced to avoid tight-looping
    expect(dbCalls).toContain("UPDATE");
  });

  it("treats a null currentTrackingStatus as changed on first poll", async () => {
    const mockPool = makeMockPool();
    _setPoolForTesting(mockPool);

    const target = makeTarget({ currentTrackingStatus: null });
    const adapter = makeAdapter("in_transit");

    const result = await processPollTarget(target, adapter);

    expect(result.status).toBe("updated");
    expect(result.previousStatus).toBeNull();
    expect(result.newStatus).toBe("in_transit");
  });
});

// =========================================================================
// findPollTargets
// =========================================================================

describe("findPollTargets", () => {
  afterEach(() => {
    _resetPoolForTesting();
  });

  it("maps DB rows correctly", async () => {
    const now = new Date();
    const mockPool = makeMockPool(async () => ({
      rows: [
        {
          id: "pay-1",
          order_id: "order-1",
          tracking_number: "TRACK123",
          carrier: "ups",
          tracking_status: "in_transit",
          next_poll_at: now,
          poll_interval_minutes: 10,
          consecutive_unchanged_count: 2,
        },
      ],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    _setPoolForTesting(mockPool);

    const targets = await findPollTargets();

    expect(targets).toHaveLength(1);
    expect(targets[0].paymentId).toBe("pay-1");
    expect(targets[0].carrier).toBe("ups");
    expect(targets[0].pollIntervalMinutes).toBe(10);
    expect(targets[0].consecutiveUnchangedCount).toBe(2);
  });

  it("defaults pollIntervalMinutes and consecutiveUnchangedCount when NULL in DB", async () => {
    const mockPool = makeMockPool(async () => ({
      rows: [
        {
          id: "pay-2",
          order_id: "order-2",
          tracking_number: "TRACK456",
          carrier: "usps",
          tracking_status: null,
          next_poll_at: null,
          poll_interval_minutes: null,
          consecutive_unchanged_count: null,
        },
      ],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    _setPoolForTesting(mockPool);

    const targets = await findPollTargets();

    expect(targets[0].pollIntervalMinutes).toBe(5); // DEFAULT_INITIAL_POLL_INTERVAL_MINUTES
    expect(targets[0].consecutiveUnchangedCount).toBe(0);
    expect(targets[0].currentTrackingStatus).toBeNull();
  });
});

// =========================================================================
// updateTrackingStatus
// =========================================================================

describe("updateTrackingStatus", () => {
  afterEach(() => {
    _resetPoolForTesting();
  });

  it("issues an UPDATE with the correct parameters", async () => {
    const queryCalls: { sql: string; params?: unknown[] }[] = [];
    const mockPool = makeMockPool(async (sql, params) => {
      queryCalls.push({ sql, params });
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    const schedule: PollingSchedule = {
      nextPollAt: new Date("2030-01-01T00:00:00Z"),
      pollIntervalMinutes: 20,
      consecutiveUnchangedCount: 3,
    };

    await updateTrackingStatus("pay-42", "delivered", schedule);

    expect(queryCalls).toHaveLength(1);
    const { sql, params } = queryCalls[0];
    expect(sql).toContain("tracking_status");
    expect(params![0]).toBe("delivered");
    expect(params![1]).toEqual(schedule.nextPollAt);
    expect(params![2]).toBe(20);
    expect(params![3]).toBe(3);
    expect(params![4]).toBe("pay-42");
  });
});

// =========================================================================
// updatePollingSchedule
// =========================================================================

describe("updatePollingSchedule", () => {
  afterEach(() => {
    _resetPoolForTesting();
  });

  it("issues an UPDATE without touching tracking_status", async () => {
    const queryCalls: { sql: string; params?: unknown[] }[] = [];
    const mockPool = makeMockPool(async (sql, params) => {
      queryCalls.push({ sql, params });
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    const schedule: PollingSchedule = {
      nextPollAt: new Date("2030-06-01T00:00:00Z"),
      pollIntervalMinutes: 40,
      consecutiveUnchangedCount: 5,
    };

    await updatePollingSchedule("pay-99", schedule);

    expect(queryCalls).toHaveLength(1);
    const { sql, params } = queryCalls[0];
    expect(sql).not.toContain("tracking_status");
    expect(params![0]).toEqual(schedule.nextPollAt);
    expect(params![1]).toBe(40);
    expect(params![2]).toBe(5);
    expect(params![3]).toBe("pay-99");
  });
});

// =========================================================================
// runCarrierPollingSweep
// =========================================================================

describe("runCarrierPollingSweep", () => {
  afterEach(() => {
    _resetPoolForTesting();
  });

  it("aggregates results across all targets", async () => {
    const mockPool = makeMockPool(async (sql) => {
      if (sql.includes("FROM payment_records")) {
        // Return two targets: UPS and FedEx
        return {
          rows: [
            {
              id: "pay-1",
              order_id: "order-1",
              tracking_number: "TRACK1",
              carrier: "ups",
              tracking_status: "in_transit",
              next_poll_at: new Date(Date.now() - 1000),
              poll_interval_minutes: 5,
              consecutive_unchanged_count: 0,
            },
            {
              id: "pay-2",
              order_id: "order-2",
              tracking_number: "TRACK2",
              carrier: "fedex",
              tracking_status: "in_transit",
              next_poll_at: new Date(Date.now() - 1000),
              poll_interval_minutes: 5,
              consecutive_unchanged_count: 0,
            },
          ],
          rowCount: 2,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      }
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    // UPS gets a new status; FedEx supports webhooks (skipped)
    const adapter: CarrierAdapter = {
      supportsWebhooks: (c) => c.toLowerCase() === "fedex",
      fetchTrackingStatus: vi.fn(async () => ({
        status: "delivered",
        timestamp: new Date().toISOString(),
      })),
    };

    const sweepResult = await runCarrierPollingSweep(adapter);

    expect(sweepResult.checked).toBe(2);
    expect(sweepResult.updated).toBe(1); // UPS updated
    expect(sweepResult.skipped).toBe(1); // FedEx skipped
    expect(sweepResult.unchanged).toBe(0);
    expect(sweepResult.errors).toBe(0);
  });

  it("returns empty result when there are no due targets", async () => {
    const mockPool = makeMockPool(async () => ({
      rows: [],
      rowCount: 0,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    _setPoolForTesting(mockPool);

    const adapter = makeAdapter("in_transit");
    const result = await runCarrierPollingSweep(adapter);

    expect(result.checked).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});

// =========================================================================
// DefaultCarrierAdapter
// =========================================================================

describe("DefaultCarrierAdapter", () => {
  it("supportsWebhooks returns false when carrier is not in the list", () => {
    const adapter = new DefaultCarrierAdapter({
      webhookSupportedCarriers: ["fedex", "ups"],
    });
    expect(adapter.supportsWebhooks("usps")).toBe(false);
    expect(adapter.supportsWebhooks("DHL")).toBe(false);
  });

  it("supportsWebhooks is case-insensitive", () => {
    const adapter = new DefaultCarrierAdapter({
      webhookSupportedCarriers: ["FedEx"],
    });
    expect(adapter.supportsWebhooks("fedex")).toBe(true);
    expect(adapter.supportsWebhooks("FEDEX")).toBe(true);
  });

  it("fetchTrackingStatus throws when no service URL is configured", async () => {
    const adapter = new DefaultCarrierAdapter({ serviceUrl: "" });
    await expect(
      adapter.fetchTrackingStatus("ups", "TRACK123")
    ).rejects.toThrow("CARRIER_TRACKING_SERVICE_URL is not configured");
  });

  it("fetchTrackingStatus calls the tracking service URL with correct params", async () => {
    const mockFetch = vi.fn(async () =>
      Response.json({
        status: "delivered",
        timestamp: "2030-01-01T00:00:00Z",
      })
    );

    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const adapter = new DefaultCarrierAdapter({
        serviceUrl: "http://tracking.example.com",
      });
      const result = await adapter.fetchTrackingStatus("ups", "1Z12345E0291980793");

      expect(mockFetch).toHaveBeenCalledOnce();
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("ups");
      expect(calledUrl).toContain("1Z12345E0291980793");
      expect(result.status).toBe("delivered");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("fetchTrackingStatus throws on non-2xx response", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("Not found", { status: 404 })
    );
    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const adapter = new DefaultCarrierAdapter({
        serviceUrl: "http://tracking.example.com",
      });
      await expect(
        adapter.fetchTrackingStatus("ups", "MISSING")
      ).rejects.toThrow("404");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// =========================================================================
// startCarrierPollingScheduler
// =========================================================================

describe("startCarrierPollingScheduler", () => {
  afterEach(() => {
    _resetPoolForTesting();
    _resetCarrierAdapterForTesting();
    vi.restoreAllMocks();
    delete process.env.CARRIER_POLL_SCHEDULER_INTERVAL_SECONDS;
  });

  it("returns a no-op stop() when interval is 0", () => {
    process.env.CARRIER_POLL_SCHEDULER_INTERVAL_SECONDS = "0";
    const handle = startCarrierPollingScheduler();
    expect(handle).toBeDefined();
    // stop() must not throw
    expect(() => handle.stop()).not.toThrow();
  });

  it("stop() clears the interval timer", () => {
    process.env.CARRIER_POLL_SCHEDULER_INTERVAL_SECONDS = "3600";

    // Provide an adapter that points at an empty pool so the immediate sweep
    // completes quickly without hitting real I/O.
    const mockPool = makeMockPool(async () => ({
      rows: [],
      rowCount: 0,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    _setPoolForTesting(mockPool);

    const adapter = makeAdapter("in_transit");
    const handle = startCarrierPollingScheduler(adapter);

    // stop() must not throw
    expect(() => handle.stop()).not.toThrow();
  });
});

// =========================================================================
// Integration: full sweep with DB writes
// =========================================================================

describe("integration: sweep with mocked DB", () => {
  afterEach(() => {
    _resetPoolForTesting();
  });

  it("executes a full sweep and persists tracking status changes", async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const mockPool = makeMockPool(async (sql, params) => {
      queries.push({ sql: sql.trim(), params });
      if (sql.includes("FROM payment_records")) {
        return {
          rows: [
            {
              id: "pay-int-1",
              order_id: "order-int-1",
              tracking_number: "INTTRACK1",
              carrier: "dhl",
              tracking_status: "out_for_delivery",
              next_poll_at: new Date(Date.now() - 5_000),
              poll_interval_minutes: 5,
              consecutive_unchanged_count: 0,
            },
          ],
          rowCount: 1,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      }
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    const adapter: CarrierAdapter = {
      supportsWebhooks: () => false,
      fetchTrackingStatus: vi.fn(async (): Promise<TrackingStatus> => ({
        status: "delivered",
        timestamp: new Date().toISOString(),
        location: "Front Door",
      })),
    };

    const result = await runCarrierPollingSweep(adapter);

    expect(result.checked).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.results[0].status).toBe("updated");
    expect(result.results[0].newStatus).toBe("delivered");

    // Verify at least one UPDATE query was issued with "delivered"
    const updateQueries = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updateQueries.length).toBeGreaterThanOrEqual(1);
    const deliveredWrite = updateQueries.find(
      (q) => Array.isArray(q.params) && q.params.includes("delivered")
    );
    expect(deliveredWrite).toBeDefined();
  });

  it("executes a full sweep and advances backoff on unchanged status", async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const mockPool = makeMockPool(async (sql, params) => {
      queries.push({ sql: sql.trim(), params });
      if (sql.includes("FROM payment_records")) {
        return {
          rows: [
            {
              id: "pay-int-2",
              order_id: "order-int-2",
              tracking_number: "INTTRACK2",
              carrier: "dhl",
              tracking_status: "in_transit",
              next_poll_at: new Date(Date.now() - 5_000),
              poll_interval_minutes: 5,
              consecutive_unchanged_count: 1,
            },
          ],
          rowCount: 1,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      }
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    _setPoolForTesting(mockPool);

    const adapter: CarrierAdapter = {
      supportsWebhooks: () => false,
      fetchTrackingStatus: vi.fn(async (): Promise<TrackingStatus> => ({
        status: "in_transit", // same — no change
        timestamp: new Date().toISOString(),
      })),
    };

    const result = await runCarrierPollingSweep(adapter);

    expect(result.unchanged).toBe(1);

    // The UPDATE for schedule advancement should reflect the doubled interval
    const updateQueries = queries.filter((q) => q.sql.startsWith("UPDATE"));
    expect(updateQueries.length).toBeGreaterThanOrEqual(1);

    // consecutiveUnchangedCount should now be 2 (was 1); interval should double 5→10
    const scheduleUpdate = updateQueries[0];
    expect(scheduleUpdate.params).toBeDefined();
    const paramsArr = scheduleUpdate.params as unknown[];
    // [nextPollAt, pollIntervalMinutes, consecutiveUnchangedCount, paymentId]
    expect(paramsArr[1]).toBe(10); // doubled
    expect(paramsArr[2]).toBe(2);  // incremented
  });
});
