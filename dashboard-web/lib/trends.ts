import type { Reading } from "./types";

// Linear-regression slope of values over time, returned in units per minute.
export function ratePerMinute(timestamps: number[], values: number[]): number | null {
  const n = timestamps.length;
  if (n < 2) return null;
  const t0 = timestamps[0];
  const xs = timestamps.map((t) => (t - t0) / 60000);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}

// Trend classification for the status card: slope of the last 10 minutes
// of readings, bucketed into up/down/stable. Needs a handful of points
// spread over a real span, not just two nearly-simultaneous ones, or the
// slope is noise; below the threshold, small drift is treated as sensor
// jitter rather than a real trend (thresholds sit above the DHT22's typical
// reading-to-reading jitter, observed as ~0.1-0.3% humidity per reading).
export const TREND_WINDOW_MS = 10 * 60 * 1000;
export const TREND_MIN_POINTS = 3;
export const TREND_MIN_SPAN_MS = 3 * 60 * 1000;
export const TEMP_TREND_THRESHOLD_C = 0.02; // °C/min
// 0.05 was too sensitive in practice: a real DHT22 sample (42.6-43.6% over
// 10 min, mostly noise with only a slight uptick in the last few readings)
// regressed to a 0.09 %/min slope and read as "up" when it visibly wasn't.
export const HUMIDITY_TREND_THRESHOLD = 0.15; // %/min

export type Trend = "up" | "down" | "stable" | null;

export function classifyTrend(slope: number | null, threshold: number): Trend {
  if (slope === null) return null;
  if (slope > threshold) return "up";
  if (slope < -threshold) return "down";
  return "stable";
}

// Direction is invariant under the C->F conversion (a positive linear
// scale), so trends are always computed in the raw stored Celsius/percent
// units regardless of the display unit toggle.
export function deviceTrends(recentReadings: Reading[]): { temp: Trend; humidity: Trend } {
  if (recentReadings.length < TREND_MIN_POINTS) return { temp: null, humidity: null };
  const sorted = recentReadings.slice().sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  const span = (sorted[sorted.length - 1].timestampMs ?? 0) - (sorted[0].timestampMs ?? 0);
  if (span < TREND_MIN_SPAN_MS) return { temp: null, humidity: null };
  const timestamps = sorted.map((r) => r.timestampMs as number);
  const tempSlope = ratePerMinute(timestamps, sorted.map((r) => r.temperature));
  const humiditySlope = ratePerMinute(timestamps, sorted.map((r) => r.humidity));
  return {
    temp: classifyTrend(tempSlope, TEMP_TREND_THRESHOLD_C),
    humidity: classifyTrend(humiditySlope, HUMIDITY_TREND_THRESHOLD),
  };
}
