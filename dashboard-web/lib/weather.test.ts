import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("lib/weather", () => {
  beforeEach(() => {
    process.env.OPEN_METEO_LATITUDE = "48.885";
    process.env.OPEN_METEO_LONGITUDE = "2.316";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPEN_METEO_LATITUDE;
    delete process.env.OPEN_METEO_LONGITUDE;
  });

  it("isWeatherConfigured reflects the env vars", async () => {
    const { isWeatherConfigured } = await import("./weather");
    expect(isWeatherConfigured()).toBe(true);
    delete process.env.OPEN_METEO_LATITUDE;
    expect(isWeatherConfigured()).toBe(false);
  });

  it("throws when not configured", async () => {
    delete process.env.OPEN_METEO_LONGITUDE;
    const { loadOfficialWeather } = await import("./weather");
    await expect(loadOfficialWeather()).rejects.toThrow("not configured");
  });

  it("parses current conditions into an ISO instant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            current: { time: "2026-07-01T12:00", temperature_2m: 27.3, relative_humidity_2m: 55 },
          }),
        ),
      ),
    );
    const { loadOfficialWeather } = await import("./weather");
    const result = await loadOfficialWeather();
    expect(result).toEqual({
      temperature: 27.3,
      humidity: 55,
      observedAt: "2026-07-01T12:00:00.000Z",
    });
  });

  it("rounds coordinates to 3 decimals before calling Open-Meteo", async () => {
    process.env.OPEN_METEO_LATITUDE = "48.8850833";
    process.env.OPEN_METEO_LONGITUDE = "2.3158611";
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrl = url;
        return Promise.resolve(
          jsonResponse({ current: { time: "2026-07-01T12:00", temperature_2m: 1, relative_humidity_2m: 2 } }),
        );
      }),
    );
    const { loadOfficialWeather } = await import("./weather");
    await loadOfficialWeather();
    const params = new URL(requestedUrl).searchParams;
    expect(params.get("latitude")).toBe("48.885");
    expect(params.get("longitude")).toBe("2.316");
  });

  it("throws a descriptive error on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("boom", { status: 500 }))));
    const { loadOfficialWeather } = await import("./weather");
    await expect(loadOfficialWeather()).rejects.toThrow(/Open-Meteo/);
  });

  it("throws when the response is missing current conditions", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({}))));
    const { loadOfficialWeather } = await import("./weather");
    await expect(loadOfficialWeather()).rejects.toThrow(/missing current conditions/);
  });
});

describe("lib/weather history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("returns an empty list when Supabase is not configured", async () => {
    const { loadOfficialWeatherHistory } = await import("./weather");
    expect(await loadOfficialWeatherHistory(24)).toEqual([]);
  });

  it("sorts rows ascending regardless of the order Supabase returns them in", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse([
            { temperature: 3, humidity: 50, observed_at: "2026-07-01T02:00:00Z" },
            { temperature: 1, humidity: 50, observed_at: "2026-07-01T00:00:00Z" },
            { temperature: 2, humidity: 50, observed_at: "2026-07-01T01:00:00Z" },
          ]),
        ),
      ),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    const result = await loadOfficialWeatherHistory(null);
    expect(result.map((r) => r.temperature)).toEqual([1, 2, 3]);
  });

  it("applies the range_hours cutoff as an observed_at filter", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrl = url;
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    await loadOfficialWeatherHistory(24);
    const params = new URL(requestedUrl).searchParams;
    expect(params.get("observed_at")).toMatch(/^gte\./);
  });

  it("omits the observed_at filter for an unbounded (null) range", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrl = url;
        return Promise.resolve(jsonResponse([]));
      }),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    await loadOfficialWeatherHistory(null);
    const params = new URL(requestedUrl).searchParams;
    expect(params.has("observed_at")).toBe(false);
  });

  it("throws a descriptive error on a non-OK response", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("boom", { status: 500 }))));
    const { loadOfficialWeatherHistory } = await import("./weather");
    await expect(loadOfficialWeatherHistory(24)).rejects.toThrow(/Supabase/);
  });
});
