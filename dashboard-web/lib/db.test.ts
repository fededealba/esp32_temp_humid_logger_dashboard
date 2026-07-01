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

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function downsample(rows: typeof ALL_ROWS, targetPoints: number) {
  if (rows.length <= targetPoints) return rows;
  const stride = Math.ceil(rows.length / targetPoints);
  return rows.filter((_, i) => i % stride === 0);
}

// Mirrors the real Supabase project's behavior as observed in manual
// testing: table/RPC responses honor an explicit `limit`/page_offset, and
// `Prefer: count=exact` returns the true row count via Content-Range even
// when the body itself is capped.
function makeMockFetch() {
  return vi.fn((url: string, init?: RequestInit) => {
    const u = new URL(url);
    const headers = new Headers(init?.headers);

    if (u.pathname === "/rest/v1/rpc/readings_downsampled") {
      const body = JSON.parse(init!.body as string);
      let rows = ALL_ROWS;
      if (body.cutoff) {
        const cutoffMs = Date.parse(body.cutoff);
        rows = rows.filter((r) => Date.parse(r.received_at) >= cutoffMs);
      }
      const sampled = downsample(rows, body.target_points);
      const page = sampled.slice(body.page_offset, body.page_offset + body.page_limit);
      return Promise.resolve(jsonResponse(page));
    }

    if (u.pathname === "/rest/v1/readings") {
      if (headers.get("Prefer") === "count=exact") {
        const cutoffParam = u.searchParams.get("received_at");
        let rows = ALL_ROWS;
        if (cutoffParam?.startsWith("gte.")) {
          const cutoffMs = Date.parse(cutoffParam.slice(4));
          rows = rows.filter((r) => Date.parse(r.received_at) >= cutoffMs);
        }
        return Promise.resolve(
          jsonResponse(rows.slice(0, 1), { "content-range": `0-0/${rows.length}` }),
        );
      }

      // Legacy bare-limit path: raw pagination via Range headers.
      const rangeHeader = headers.get("Range");
      let from = 0;
      let to = ALL_ROWS.length - 1;
      if (rangeHeader) {
        const [f, t] = rangeHeader.split("-").map(Number);
        from = f;
        to = t;
      }
      return Promise.resolve(jsonResponse(ALL_ROWS.slice(from, to + 1)));
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

  it("downsamples across multiple RPC pages without dropping or duplicating rows", async () => {
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: null, limit: Number.MAX_SAFE_INTEGER, maxPoints: 2000 });

    expect(result.rowsInRange).toBe(TOTAL);
    // stride=2 for 2500 rows / 2000 target -> 1250 sampled rows, spanning
    // more than one 1000-row page.
    expect(result.readings.length).toBeGreaterThan(1000);
    const ids = result.readings.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("requests each downsample page with an increasing page_offset", async () => {
    const offsets: number[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/rest/v1/rpc/readings_downsampled") {
        offsets.push(JSON.parse(init!.body as string).page_offset);
      }
      return makeMockFetch()(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { loadReadings } = await import("./db");
    await loadReadings({ rangeHours: null, limit: Number.MAX_SAFE_INTEGER, maxPoints: 2000 });

    // Regression guard: PostgREST does not paginate `setof` RPC results via
    // Range headers (it silently repeats the first page), which is why
    // page_offset/page_limit must be explicit function arguments instead.
    expect(offsets).toEqual([0, 1000]);
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
    vi.stubGlobal("fetch", makeMockFetch());
    const { loadReadings } = await import("./db");
    const result = await loadReadings({ rangeHours: 24 });

    expect(result.rowsInRange).toBeLessThan(TOTAL);
    const cutoffMs = NOW - 24 * 3_600_000;
    for (const reading of result.readings) {
      expect(reading.timestampMs).not.toBeNull();
      expect(reading.timestampMs as number).toBeGreaterThanOrEqual(cutoffMs);
    }
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
        if (u.pathname === "/rest/v1/rpc/readings_downsampled") {
          return Promise.resolve(
            jsonResponse([
              {
                id: 1,
                device_id: "x",
                temperature: 1,
                humidity: 2,
                device_ts: "2026-01-01T00:00:00Z",
                received_at: "2026-01-02T00:00:00Z",
              },
            ]),
          );
        }
        // The exact-count query, run in parallel; content doesn't matter here.
        return Promise.resolve(jsonResponse([{ id: 1 }], { "content-range": "0-0/1" }));
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
