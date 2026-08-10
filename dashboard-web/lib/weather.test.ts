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
  beforeEach(() => {
    process.env.OPEN_METEO_LATITUDE = "48.885";
    process.env.OPEN_METEO_LONGITUDE = "2.316";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.OPEN_METEO_LATITUDE;
    delete process.env.OPEN_METEO_LONGITUDE;
  });

  function hourlyResponse(times: string[], temps: number[], hums: number[]) {
    return jsonResponse({ hourly: { time: times, temperature_2m: temps, relative_humidity_2m: hums } });
  }

  it("returns an empty list when Open-Meteo is not configured", async () => {
    delete process.env.OPEN_METEO_LATITUDE;
    const { loadOfficialWeatherHistory } = await import("./weather");
    expect(await loadOfficialWeatherHistory(24)).toEqual([]);
  });

  it("maps hourly arrays into points with ISO instants", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T15:30:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          hourlyResponse(
            ["2026-08-10T13:00", "2026-08-10T14:00", "2026-08-10T15:00"],
            [28.1, 29.2, 30.3],
            [40, 41, 42],
          ),
        ),
      ),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    const result = await loadOfficialWeatherHistory(null);
    expect(result).toEqual([
      { temperature: 28.1, humidity: 40, observedAt: "2026-08-10T13:00:00.000Z" },
      { temperature: 29.2, humidity: 41, observedAt: "2026-08-10T14:00:00.000Z" },
      { temperature: 30.3, humidity: 42, observedAt: "2026-08-10T15:00:00.000Z" },
    ]);
  });

  it("drops hourly points beyond the current time (the forecast_days=1 buffer)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T15:30:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          hourlyResponse(["2026-08-10T15:00", "2026-08-10T16:00", "2026-08-10T17:00"], [30, 31, 32], [40, 41, 42]),
        ),
      ),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    const result = await loadOfficialWeatherHistory(null);
    expect(result.map((p) => p.observedAt)).toEqual(["2026-08-10T15:00:00.000Z"]);
  });

  it("applies the rangeHours cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T15:30:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          hourlyResponse(
            ["2026-08-10T12:00", "2026-08-10T13:00", "2026-08-10T14:00", "2026-08-10T15:00"],
            [1, 2, 3, 4],
            [40, 40, 40, 40],
          ),
        ),
      ),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    // 2h range from a 15:30 "now" -> cutoff 13:30, so 12:00 and 13:00 drop out.
    const result = await loadOfficialWeatherHistory(2);
    expect(result.map((p) => p.observedAt)).toEqual(["2026-08-10T14:00:00.000Z", "2026-08-10T15:00:00.000Z"]);
  });

  it.each([
    [24, "1"],
    [200, "9"],
    [null, "92"],
  ])("converts rangeHours=%s to past_days=%s", async (rangeHours, expectedPastDays) => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrl = url;
        return Promise.resolve(hourlyResponse([], [], []));
      }),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    await loadOfficialWeatherHistory(rangeHours);
    const params = new URL(requestedUrl).searchParams;
    expect(params.get("past_days")).toBe(expectedPastDays);
  });

  it("rounds coordinates to 3 decimals before calling Open-Meteo", async () => {
    process.env.OPEN_METEO_LATITUDE = "48.8850833";
    process.env.OPEN_METEO_LONGITUDE = "2.3158611";
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrl = url;
        return Promise.resolve(hourlyResponse([], [], []));
      }),
    );
    const { loadOfficialWeatherHistory } = await import("./weather");
    await loadOfficialWeatherHistory(24);
    const params = new URL(requestedUrl).searchParams;
    expect(params.get("latitude")).toBe("48.885");
    expect(params.get("longitude")).toBe("2.316");
  });

  it("throws a descriptive error on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("boom", { status: 500 }))));
    const { loadOfficialWeatherHistory } = await import("./weather");
    await expect(loadOfficialWeatherHistory(24)).rejects.toThrow(/Open-Meteo/);
  });
});
