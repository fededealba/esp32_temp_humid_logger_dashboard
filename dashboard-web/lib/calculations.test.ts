// Tests for the pure calculations behind the dashboard's status card and
// charts. Expected values come from independent references (NWS heat-index
// table, standard Magnus-formula values), not from re-running the code.
import { describe, it, expect } from "vitest";
import { absoluteHumidity, dewPointCelsius, heatIndexCelsius } from "./psychrometrics";
import { classifyTrend, deviceTrends, ratePerMinute } from "./trends";
import { withGapBreaks } from "./gaps";
import { zonedDateString, zonedDateStringMs } from "./zoned-time";
import { toFahrenheit, toFahrenheitDelta } from "./units";
import { formatAge } from "./format";
import type { Reading } from "./types";

const MIN = 60_000;
const fToC = (f: number) => ((f - 32) * 5) / 9;

describe("psychrometrics", () => {
  it("heat index matches the NWS table", () => {
    // NWS heat index chart: 90°F at 70% RH -> 106°F; 96°F at 50% -> 108°F.
    expect(heatIndexCelsius(fToC(90), 70)).toBeCloseTo(fToC(106), 0);
    expect(heatIndexCelsius(fToC(96), 50)).toBeCloseTo(fToC(108), 0);
  });

  it("heat index is just the air temperature below ~27°C", () => {
    expect(heatIndexCelsius(22, 90)).toBe(22);
  });

  it("dew point: 20°C at 50% RH is ~9.3°C, and equals the air temp at 100%", () => {
    expect(dewPointCelsius(20, 50)).toBeCloseTo(9.26, 1);
    expect(dewPointCelsius(25, 100)).toBeCloseTo(25, 5);
  });

  it("absolute humidity: 20°C at 50% RH is ~8.6 g/m³ (saturation ~17.3)", () => {
    expect(absoluteHumidity(20, 50)).toBeCloseTo(8.64, 1);
    expect(absoluteHumidity(20, 100)).toBeCloseTo(17.3, 0);
  });
});

describe("units and formatting", () => {
  it("converts absolute temperatures and differences differently", () => {
    expect(toFahrenheit(100)).toBe(212);
    expect(toFahrenheit(-40)).toBe(-40);
    expect(toFahrenheitDelta(10)).toBe(18); // a 10°C difference, no +32
  });

  it("formats ages in minutes and hours", () => {
    expect(formatAge(59 * MIN)).toBe("59 min");
    expect(formatAge(65 * MIN)).toBe("1 h 5 min");
    expect(formatAge(120 * MIN)).toBe("2 h");
  });
});

function reading(minutesAgo: number, temperature: number, humidity: number, now: number): Reading {
  const t = now - minutesAgo * MIN;
  return {
    id: minutesAgo,
    temperature,
    humidity,
    deviceId: "dev",
    receivedAt: new Date(t).toISOString(),
    deviceTimestamp: null,
    timestamp: new Date(t).toISOString(),
    timestampMs: t,
  };
}

describe("trends", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");

  it("ratePerMinute recovers an exact linear slope", () => {
    const ts = [0, 1, 2, 3].map((m) => now + m * MIN);
    expect(ratePerMinute(ts, [10, 10.5, 11, 11.5])).toBeCloseTo(0.5, 10);
    expect(ratePerMinute([now], [1])).toBeNull();
    expect(ratePerMinute([now, now], [1, 2])).toBeNull(); // zero time span
  });

  it("classifyTrend applies the threshold symmetrically", () => {
    expect(classifyTrend(0.2, 0.15)).toBe("up");
    expect(classifyTrend(-0.2, 0.15)).toBe("down");
    expect(classifyTrend(0.1, 0.15)).toBe("stable");
    expect(classifyTrend(null, 0.15)).toBeNull();
  });

  it("flags a real humidity rise but not DHT22-style jitter", () => {
    // Humidity climbing 0.3 %/min for 10 min: clearly up.
    const rising = Array.from({ length: 10 }, (_, i) => reading(9 - i, 21, 40 + i * 0.3, now));
    expect(deviceTrends(rising).humidity).toBe("up");
    // ±0.3% jitter around 43%, the noise that used to read as "up".
    const jitter = [43.1, 42.8, 43.3, 42.9, 43.2, 42.7, 43.4, 43.0, 42.9, 43.2];
    const noisy = jitter.map((h, i) => reading(9 - i, 21, h, now));
    expect(deviceTrends(noisy).humidity).toBe("stable");
  });

  it("needs enough points over a real span before calling a trend", () => {
    const two = [reading(1, 20, 40, now), reading(0, 25, 60, now)];
    expect(deviceTrends(two)).toEqual({ temp: null, humidity: null });
    const bunched = [reading(2, 20, 40, now), reading(1, 22, 50, now), reading(0, 25, 60, now)];
    expect(deviceTrends(bunched)).toEqual({ temp: null, humidity: null }); // 2 min < 3 min span
  });
});

describe("withGapBreaks", () => {
  const t0 = Date.parse("2026-11-25T00:00:00Z");

  it("leaves a regular series untouched", () => {
    const ts = Array.from({ length: 10 }, (_, i) => t0 + i * MIN);
    const points = withGapBreaks(ts, ts.map(() => 20), MIN);
    expect(points).toHaveLength(10);
    expect(points.every((p) => p.value !== null && !p.marker)).toBe(true);
  });

  it("breaks the line mid-outage and marks the readings around it", () => {
    const ts = [0, 1, 2, 3, 33, 34, 35].map((m) => t0 + m * MIN); // 30-min outage
    const points = withGapBreaks(ts, [1, 2, 3, 4, 5, 6, 7], MIN);
    expect(points).toHaveLength(8);
    expect(points[4]).toEqual({ t: t0 + 18 * MIN, value: null, marker: false });
    expect(points.filter((p) => p.marker).map((p) => p.value)).toEqual([4, 5]);
  });

  it("adapts to downsampled spacing instead of treating every step as a gap", () => {
    const ts = Array.from({ length: 10 }, (_, i) => t0 + i * 5 * MIN); // every 5th reading
    expect(withGapBreaks(ts, ts.map(() => 20), MIN).some((p) => p.value === null)).toBe(false);
  });

  it("ignores ordinary jitter at the raw cadence", () => {
    const ts = [0, 1, 2, 4.5, 5.5, 6.5].map((m) => t0 + m * MIN); // one 2.5-min hiccup
    expect(withGapBreaks(ts, ts.map(() => 20), MIN).some((p) => p.value === null)).toBe(false);
  });
});

describe("zoned-time", () => {
  it("renders wall-clock time in the chosen zone, across DST", () => {
    // Paris springs forward at 01:00 UTC on 2026-03-29 (02:00 -> 03:00 local).
    expect(zonedDateString(Date.parse("2026-03-29T00:30:00Z"), "Europe/Paris")).toBe("2026-03-29 01:30:00");
    expect(zonedDateString(Date.parse("2026-03-29T01:30:00Z"), "Europe/Paris")).toBe("2026-03-29 03:30:00");
  });

  it("renders local midnight as 00, not 24", () => {
    expect(zonedDateString(Date.parse("2026-11-24T23:00:00Z"), "Europe/Paris")).toBe("2026-11-25 00:00:00");
  });

  it("zonedDateStringMs preserves chronological order", () => {
    const a = zonedDateString(Date.parse("2026-11-25T08:59:59Z"), "US/Pacific");
    const b = zonedDateString(Date.parse("2026-11-25T09:00:00Z"), "US/Pacific");
    expect(zonedDateStringMs(a)).toBeLessThan(zonedDateStringMs(b));
  });
});
