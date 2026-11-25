import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const TOTAL = 2500;

// Newest first, one reading per minute, matching the real device's cadence.
const ALL_ROWS = Array.from({ length: TOTAL }, (_, i) => {
  const t = new Date(NOW - i * 60_000);
  return {
    id: TOTAL - i,
    device_id: "AA:BB:CC:DD:EE:FF",
    temperature: 20 + Math.sin(i / 10),
    humidity: 50 + Math.cos(i / 10),
    device_ts: t.toISOString(),
    received_at: t.toISOString(),
  };
});

// A second device, interleaved with ALL_ROWS but at a jittered (not exactly
// regular) offset — closer to real-world timing than a fixed offset, so a
// global (rather than per-device) stride bug can't get lucky and produce an
// evenly-alternating pick by coincidence.
const TOTAL_B = 800;
const DEVICE_B_ROWS = Array.from({ length: TOTAL_B }, (_, i) => {
  const jitterMs = ((i * 37) % 50) * 1000;
  const t = new Date(NOW - i * 60_000 - jitterMs);
  return {
    id: 100_000 + TOTAL_B - i,
    device_id: "TP357 (TEST)",
    temperature: 22 + Math.cos(i / 8),
    humidity: 45 + Math.sin(i / 8),
    device_ts: t.toISOString(),
    received_at: t.toISOString(),
  };
});
const MULTI_DEVICE_ROWS = [...ALL_ROWS, ...DEVICE_B_ROWS].sort(
  (a, b) => Date.parse(b.received_at) - Date.parse(a.received_at),
);

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Mirrors the real (fixed) readings_downsampled SQL function: the stride is
// computed independently per device_id, not across the whole combined set.
function downsample(rows: typeof ALL_ROWS, targetPoints: number) {
  const byDevice = new Map<string, typeof ALL_ROWS>();
  for (const r of rows) {
    const list = byDevice.get(r.device_id) ?? [];
    list.push(r);
    byDevice.set(r.device_id, list);
  }
  const out: typeof ALL_ROWS = [];
  for (const deviceRows of byDevice.values()) {
    if (deviceRows.length <= targetPoints) {
      out.push(...deviceRows);
    } else {
      const stride = Math.ceil(deviceRows.length / targetPoints);
      out.push(...deviceRows.filter((_, i) => i % stride === 0));
    }
  }
  return out.sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
}

// Mirrors the real Supabase project's behavior: readings_downsampled_json
// returns one JSON value with the per-device sample and the in-range total,
// and the table endpoint honors Range headers.
function makeMockFetch(sourceRows: typeof ALL_ROWS = ALL_ROWS) {
  return vi.fn((url: string, init?: RequestInit) => {
    const u = new URL(url);
    const headers = new Headers(init?.headers);

    if (u.pathname === "/rest/v1/rpc/readings_downsampled_json") {
      const body = JSON.parse(init!.body as string);
      let rows = sourceRows;
      if (body.cutoff) {
        const cutoffMs = Date.parse(body.cutoff);
        rows = rows.filter((r) => Date.parse(r.received_at) >= cutoffMs);
      }
      return Promise.resolve(
        jsonResponse({ rows: downsample(rows, body.target_points), total_in_range: rows.length }),
      );
    }

    if (u.pathname === "/rest/v1/readings") {
      // Raw pagination via Range headers (legacy bare-limit path, and the
      // single-row `latest` lookup).
      const rangeHeader = headers.get("Range");
      let from = 0;
      let to = sourceRows.length - 1;
      if (rangeHeader) {
        const [f, t] = rangeHeader.split("-").map(Number);
        from = f;
        to = t;
      }
      return Promise.resolve(jsonResponse(sourceRows.slice(from, to + 1)));
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

describe("lib/db", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("isSupabaseConfigured reflects the env vars", async () => {
    const { isSupabaseConfigured } = await import("./db");
    expect(isSupabaseConfigured()).toBe(true);
    delete process.env.SUPABASE_URL;
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("throws when Supabase is not configured", async () => {
    delete process.env.SUPABASE_URL;
    const { loadReadings } = await import("./db");
    await expect(loadReadings()).rejects.toThrow("Supabase is not configured.");
  });

  it("returns the whole per-device sample without dropping or duplicating rows", async () => {
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: null, limit: Number.MAX_SAFE_INTEGER, maxPoints: 2000 });

    expect(result.rowsInRange).toBe(TOTAL);
    // stride=2 for 2500 rows / 2000 target -> 1250 sampled rows: more than
    // Supabase's 1,000-row cap on row-set responses, which the JSON-valued
    // function isn't subject to.
    expect(result.readings).toHaveLength(1250);
    const ids = result.readings.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("downsamples each device independently instead of by a shared global stride", async () => {
    vi.stubGlobal("fetch", makeMockFetch(MULTI_DEVICE_ROWS));
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: null, limit: Number.MAX_SAFE_INTEGER, maxPoints: 2000 });

    const byDevice = new Map<string, number[]>();
    for (const r of result.readings) {
      const list = byDevice.get(r.deviceId) ?? [];
      list.push(r.timestampMs as number);
      byDevice.set(r.deviceId, list);
    }

    // Device A (2500 raw rows) needs downsampling (stride 2 -> 1250 points);
    // device B (800 raw rows) doesn't and should come through untouched. A
    // shared global stride computed across both interleaved devices would
    // skew this split and/or cluster each device's own points unevenly,
    // instead of spacing them out across its own full time range.
    expect(byDevice.get("AA:BB:CC:DD:EE:FF")).toHaveLength(1250);
    expect(byDevice.get("TP357 (TEST)")).toHaveLength(TOTAL_B);

    // Device A's sampled points should be evenly spaced (uniform 2-minute
    // gaps), not clustered — this is what the bug actually looked like on
    // the live dashboard: bursts of points separated by gaps.
    const deviceATimestamps = byDevice.get("AA:BB:CC:DD:EE:FF")!.slice().sort((a, b) => a - b);
    const gaps = new Set<number>();
    for (let i = 1; i < deviceATimestamps.length; i++) {
      gaps.add(deviceATimestamps[i] - deviceATimestamps[i - 1]);
    }
    expect(gaps.size).toBe(1); // exactly one distinct gap size = perfectly even spacing
  });

  it("fetches the sample in a single RPC call, with no separate count query", async () => {
    const fetchMock = makeMockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { loadReadings } = await import("./db");
    await loadReadings({ rangeHours: 24, maxPoints: 500 });

    // Regression guard: the old paged function re-ran the full window
    // computation once per 1,000-row page (4 passes for "all", ~5s), plus a
    // separate count=exact over the whole table.
    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: new URL(url), init }));
    const rpcCalls = calls.filter((c) => c.url.pathname.startsWith("/rest/v1/rpc/"));
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].url.pathname).toBe("/rest/v1/rpc/readings_downsampled_json");
    const body = JSON.parse(rpcCalls[0].init!.body as string);
    expect(body.target_points).toBe(500);
    expect(typeof body.cutoff).toBe("string");
    expect(calls.some((c) => new Headers(c.init?.headers).get("Prefer") === "count=exact")).toBe(false);
  });

  it("reports an unexpected RPC response shape instead of returning empty data", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
      new URL(url).pathname === "/rest/v1/rpc/readings_downsampled_json"
        ? Promise.resolve(jsonResponse([]))
        : makeMockFetch()(url, init),
    ));
    const { loadReadings } = await import("./db");
    await expect(loadReadings({ rangeHours: 24 })).rejects.toThrow(/unexpected shape/);
  });

  it("does not truncate a large 'all time' result to a fixed row cap", async () => {
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: null, limit: Number.MAX_SAFE_INTEGER, maxPoints: 100 });

    // rowsInRange must reflect the whole table, not a capped subset, even
    // though only ~100 points are actually returned.
    expect(result.rowsInRange).toBe(TOTAL);
    expect(result.readings.length).toBeLessThanOrEqual(100);
  });

  it("applies the time window server-side", async () => {
    // Pin the clock to the fixtures' NOW; against the real clock the window
    // is empty and the per-row assertions below would pass vacuously.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: 24 });
    vi.useRealTimers();

    expect(result.readings.length).toBeGreaterThan(0);
    expect(result.rowsInRange).toBeLessThan(TOTAL);
    const cutoffMs = NOW - 24 * 3_600_000;
    for (const reading of result.readings) {
      expect(reading.timestampMs).not.toBeNull();
      expect(reading.timestampMs as number).toBeGreaterThanOrEqual(cutoffMs);
    }
  });

  it("returns the newest reading even when the outage is longer than the window", async () => {
    // Device last posted at NOW; it's now 3h later and the user is on the 1h view.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + 3 * 3_600_000);
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: 1 });
    vi.useRealTimers();

    expect(result.readings).toHaveLength(0);
    expect(result.latest?.id).toBe(TOTAL);
    expect(result.latest?.timestampMs).toBe(NOW);
  });

  it("returns the stale-check heartbeat from alert_state", async () => {
    const base = makeMockFetch();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
      new URL(url).pathname === "/rest/v1/alert_state"
        ? Promise.resolve(jsonResponse([{ last_checked_at: "2026-07-01T11:57:00+00:00" }]))
        : base(url, init),
    ));
    const { loadReadings } = await import("./db");
    expect((await loadReadings({ rangeHours: 24 })).alertsCheckedAt).toBe("2026-07-01T11:57:00+00:00");
    expect((await loadReadings({ rangeHours: null, limit: 10 })).alertsCheckedAt).toBe("2026-07-01T11:57:00+00:00");
  });

  it("treats a missing heartbeat as unknown without failing the readings request", async () => {
    // makeMockFetch 404s alert_state, like a schema without the table/column.
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: 24 });
    expect(result.ok).toBe(true);
    expect(result.alertsCheckedAt).toBeNull();
  });

  it("legacy bare-limit path returns raw, unsampled rows newest-first", async () => {
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: null, limit: 50, maxPoints: 2000 });

    expect(result.stride).toBe(1);
    expect(result.readings).toHaveLength(50);
    expect(result.readings[0].id).toBe(TOTAL); // newest row
  });

  it("prefers device_ts over received_at when they disagree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = new URL(url);
        if (u.pathname === "/rest/v1/rpc/readings_downsampled_json") {
          return Promise.resolve(
            jsonResponse({
              total_in_range: 1,
              rows: [
                {
                  id: 1,
                  device_id: "x",
                  temperature: 1,
                  humidity: 2,
                  device_ts: "2026-01-01T00:00:00Z",
                  received_at: "2026-01-02T00:00:00Z",
                },
              ],
            }),
          );
        }
        // The parallel `latest` / heartbeat lookups; content doesn't matter here.
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: 24 });
    expect(result.readings[0].timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("throws a descriptive error when Supabase returns a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("boom", { status: 500 }))));
    const { loadReadings } = await import("./db");
    await expect(loadReadings({ rangeHours: 24 })).rejects.toThrow(/Supabase/);
  });
});
