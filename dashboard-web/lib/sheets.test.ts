import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("google-auth-library", () => ({
  // `new JWT(...)` requires a constructible mock; an arrow function isn't one.
  JWT: vi.fn().mockImplementation(function MockJWT() {
    return { getAccessToken: vi.fn().mockResolvedValue({ token: "fake-token" }) };
  }),
}));

const HEADER_ROW = ["Timestamp", "Temperature", "Humidity", "Device ID", "Device Timestamp"];

function sheetRow(receivedAt: string, temperature: string, humidity: string, deviceId: string, deviceTs: string) {
  return [receivedAt, temperature, humidity, deviceId, deviceTs];
}

function mockFetch(sheetTitle: string, values: string[][]) {
  return vi.fn((url: string) => {
    if (url.includes("fields=sheets")) {
      return Promise.resolve(
        new Response(JSON.stringify({ sheets: [{ properties: { title: sheetTitle } }] }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ values }), { status: 200 }));
  });
}

describe("lib/sheets", () => {
  beforeEach(() => {
    process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify({
      client_email: "test@example.com",
      private_key: "fake-key",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_CREDENTIALS_JSON;
    delete process.env.GOOGLE_CREDENTIALS_FILE;
    delete process.env.GOOGLE_SHEETS_ID;
  });

  it("parses valid rows and drops rows missing temperature or humidity", async () => {
    const values = [
      HEADER_ROW,
      sheetRow("6/1/2026 10:00:00", "21.5", "45.0", "AA:BB", "2026-06-01T10:00:00Z"),
      sheetRow("6/1/2026 10:01:00", "", "46.0", "AA:BB", "2026-06-01T10:01:00Z"), // missing temperature
      sheetRow("6/1/2026 10:02:00", "22.0", "44.5", "AA:BB", "2026-06-01T10:02:00Z"),
    ];
    vi.stubGlobal("fetch", mockFetch("Form Responses 1", values));

    const { loadReadings } = await import("./sheets");
    const result = await loadReadings({ rangeHours: null, limit: 10, maxPoints: 10 });

    expect(result.sheetTitle).toBe("Form Responses 1");
    expect(result.rowsLoaded).toBe(3);
    expect(result.readings).toHaveLength(2);
  });

  it("maps 'Device ID' and 'Device Timestamp' to separate fields (regression: substring collision)", async () => {
    // Both headers contain "device"; mapHeader must not let the ID column's
    // mapping get clobbered by the timestamp column just because it also
    // matches the generic "device" check.
    const values = [
      HEADER_ROW,
      sheetRow("6/1/2026 10:00:00", "21.5", "45.0", "AA:BB:CC:DD:EE:FF", "2026-06-01T10:00:00Z"),
    ];
    vi.stubGlobal("fetch", mockFetch("Sheet1", values));

    const { loadReadings } = await import("./sheets");
    const result = await loadReadings({ rangeHours: null, limit: 10, maxPoints: 10 });

    expect(result.readings[0].deviceId).toBe("AA:BB:CC:DD:EE:FF");
    expect(result.readings[0].deviceTimestamp).toBe("2026-06-01T10:00:00Z");
  });

  it("sorts newest first by resolved timestamp", async () => {
    const values = [
      HEADER_ROW,
      sheetRow("x", "20", "40", "AA:BB", "2026-06-01T10:00:00Z"),
      sheetRow("x", "21", "41", "AA:BB", "2026-06-01T10:05:00Z"),
      sheetRow("x", "22", "42", "AA:BB", "2026-06-01T10:02:00Z"),
    ];
    vi.stubGlobal("fetch", mockFetch("Sheet1", values));

    const { loadReadings } = await import("./sheets");
    const result = await loadReadings({ rangeHours: null, limit: 10, maxPoints: 10 });

    expect(result.readings.map((r) => r.deviceTimestamp)).toEqual([
      "2026-06-01T10:05:00Z",
      "2026-06-01T10:02:00Z",
      "2026-06-01T10:00:00Z",
    ]);
  });

  it("windows by rangeHours, dropping rows older than the cutoff", async () => {
    const now = Date.now();
    const recentIso = new Date(now - 30 * 60_000).toISOString();
    const oldIso = new Date(now - 3 * 60 * 60_000).toISOString();
    const values = [
      HEADER_ROW,
      sheetRow("x", "20", "40", "AA:BB", recentIso),
      sheetRow("x", "21", "41", "AA:BB", oldIso),
    ];
    vi.stubGlobal("fetch", mockFetch("Sheet1", values));

    const { loadReadings } = await import("./sheets");
    const result = await loadReadings({ rangeHours: 1, maxPoints: 10 });

    expect(result.readings).toHaveLength(1);
    expect(result.readings[0].deviceTimestamp).toBe(recentIso);
  });

  it("downsamples by stride while always keeping the newest row", async () => {
    const base = Date.now();
    const values = [HEADER_ROW];
    for (let i = 0; i < 100; i++) {
      const ts = new Date(base - i * 60_000).toISOString();
      values.push(sheetRow("x", String(20 + i), "40", "AA:BB", ts));
    }
    vi.stubGlobal("fetch", mockFetch("Sheet1", values));

    const { loadReadings } = await import("./sheets");
    const result = await loadReadings({ rangeHours: null, limit: 100, maxPoints: 10 });

    expect(result.stride).toBe(10);
    expect(result.readings.length).toBeLessThanOrEqual(10);
    expect(result.readings[0].deviceTimestamp).toBe(new Date(base).toISOString());
  });

  it("throws when no Google credentials are available", async () => {
    delete process.env.GOOGLE_CREDENTIALS_JSON;
    process.env.GOOGLE_CREDENTIALS_FILE = "/nonexistent/credentials.json";
    vi.stubGlobal("fetch", mockFetch("Sheet1", [HEADER_ROW]));

    const { loadReadings } = await import("./sheets");
    await expect(loadReadings()).rejects.toThrow(/credentials/i);
  });
});
