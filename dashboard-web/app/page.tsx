"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Config, Data, Layout } from "plotly.js";

type Reading = {
  id: number;
  sheetRow: number;
  temperature: number;
  humidity: number;
  deviceId: string;
  receivedAt: string | null;
  deviceTimestamp: string | null;
  timestamp: string | null;
  timestampMs: number | null;
};

type ApiResponse =
  | {
      ok: true;
      generatedAt: string;
      sheetTitle: string;
      rowsLoaded: number;
      rowsInRange: number;
      stride: number;
      rangeHours: number | null;
      readings: Reading[];
    }
  | {
      ok: false;
      error: string;
    };

type WeatherResponse =
  | { ok: true; configured: false }
  | {
      ok: true;
      configured: true;
      temperature: number;
      humidity: number;
      observedAt: string;
    }
  | { ok: false; error: string };

type WeatherHistoryResponse =
  | { ok: true; points: { temperature: number; humidity: number; observedAt: string }[] }
  | { ok: false; error: string };

const TIMEZONES = [
  "Europe/Paris",
  "UTC",
  "US/Eastern",
  "US/Central",
  "US/Mountain",
  "US/Pacific",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const RANGES = [
  { label: "1h", hours: 1 },
  { label: "12h", hours: 12 },
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
  { label: "72h", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "All", hours: null },
];

// Cadence the ESP32 firmware posts at (BASE_INTERVAL_MS). Drives both the
// staleness threshold and the chart-gap detection floor.
const POST_INTERVAL_MS = 60 * 1000;
// Warn when the newest reading is older than ~5 missed posts.
const STALE_AFTER_MS = 5 * POST_INTERVAL_MS;

// Per-device line colors for the temperature/humidity charts. Index 0 in
// each palette matches the original single-device color exactly, so nothing
// changes visually when only one device is present — additional devices
// cycle through the rest of the palette.
const TEMP_COLORS = {
  light: ["#c2410c", "#be185d", "#b45309", "#7c2d12"],
  dark: ["#f97316", "#fb7185", "#fbbf24", "#fb923c"],
};
const HUMIDITY_COLORS = {
  light: ["#087ea4", "#7c3aed", "#0d9488", "#4338ca"],
  dark: ["#38bdf8", "#a78bfa", "#2dd4bf", "#818cf8"],
};
// Area fill under the line only makes sense with a single trace; with two+
// devices overlapping semi-transparent fills just looks muddy, so it's only
// used when there's exactly one device.
const TEMP_FILL = { light: "rgba(194, 65, 12, 0.12)", dark: "rgba(249, 115, 22, 0.18)" };
const HUMIDITY_FILL = { light: "rgba(8, 126, 164, 0.12)", dark: "rgba(56, 189, 248, 0.18)" };
// Neutral (not orange/pink like TEMP_COLORS, not blue/purple like
// HUMIDITY_COLORS) so the official reference line reads as "background
// context" rather than another device.
const OFFICIAL_COLOR = { light: "#78716c", dark: "#a8a29e" };

function formatAge(ms: number) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function formatNumber(value: number, digits = 1) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function toFahrenheit(celsius: number) {
  return celsius * 1.8 + 32;
}

// For a *difference* between two Celsius readings, not an absolute value —
// skips the +32 offset (which would cancel out anyway, but this makes the
// intent explicit at call sites instead of relying on that cancellation).
function toFahrenheitDelta(deltaCelsius: number) {
  return deltaCelsius * 1.8;
}

// Rothfusz regression of Steadman's heat-index table. Only meaningful above
// ~27 °C; below that the perceived temperature is essentially the air temp.
function heatIndexCelsius(tempC: number, humidity: number): number {
  if (tempC < 26.7) return tempC;
  const T = tempC * 9 / 5 + 32;
  const R = humidity;
  const hiF =
    -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
    - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
    + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
  return ((hiF - 32) * 5) / 9;
}

// August-Roche-Magnus approximation, accurate to within ~0.4°C for
// -45..60°C. Same family of formula the heat index above is tuned from.
function dewPointCelsius(tempC: number, humidity: number): number {
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(humidity / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

// Saturation vapor pressure (Magnus formula) scaled to actual vapor
// pressure by RH, then converted to a mass concentration via the ideal gas
// law for water vapor. Returns grams of water vapor per cubic meter of air.
function absoluteHumidity(tempC: number, humidity: number): number {
  const satVaporPressureHpa = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
  const vaporPressureHpa = (humidity / 100) * satVaporPressureHpa;
  return (216.7 * vaporPressureHpa) / (tempC + 273.15);
}

function formatTime(reading: Reading, timezone: string) {
  if (!reading.timestampMs) return "No timestamp";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(reading.timestampMs));
}

function useDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setIsDark(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDark;
}

// Linear-regression slope of values over time, returned in units per minute.
function ratePerMinute(timestamps: number[], values: number[]): number | null {
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
const TREND_WINDOW_MS = 10 * 60 * 1000;
const TREND_MIN_POINTS = 3;
const TREND_MIN_SPAN_MS = 3 * 60 * 1000;
const TEMP_TREND_THRESHOLD_C = 0.02; // °C/min
// 0.05 was too sensitive in practice: a real DHT22 sample (42.6-43.6% over
// 10 min, mostly noise with only a slight uptick in the last few readings)
// regressed to a 0.09 %/min slope and read as "up" when it visibly wasn't.
const HUMIDITY_TREND_THRESHOLD = 0.15; // %/min

type Trend = "up" | "down" | "stable" | null;

function classifyTrend(slope: number | null, threshold: number): Trend {
  if (slope === null) return null;
  if (slope > threshold) return "up";
  if (slope < -threshold) return "down";
  return "stable";
}

// Direction is invariant under the C->F conversion (a positive linear
// scale), so trends are always computed in the raw stored Celsius/percent
// units regardless of the display unit toggle.
function deviceTrends(recentReadings: Reading[]): { temp: Trend; humidity: Trend } {
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

function TrendArrow({ trend }: { trend: Trend }) {
  if (trend === null) return null;
  const symbol = trend === "up" ? "▲" : trend === "down" ? "▼" : "→";
  const label = trend === "up" ? "increasing" : trend === "down" ? "decreasing" : "stable";
  return (
    <span className="trend-arrow" title={`${label} over the last 10 min`} aria-label={label}>
      {symbol}
    </span>
  );
}

type PlotlyApi = typeof import("plotly.js");

// The div Plotly.react attaches to gets `on`/`removeAllListeners` methods
// bolted on. Type them narrowly so we don't need to `as any` every time we
// wire up an event listener.
type PlotlyEventDiv = HTMLDivElement & {
  on(name: string, handler: (e: Record<string, unknown>) => void): void;
  removeAllListeners(name: string): void;
};

// Plotly's plotly_relayout event usually delivers date-axis range values as
// strings, but versions have varied (numbers, Date objects). Normalise so
// callers can safely store `[string, string]`.
function normalizeAxisValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

let plotlyPromise: Promise<PlotlyApi> | null = null;

function loadPlotly(): Promise<PlotlyApi> {
  if (!plotlyPromise) {
    plotlyPromise = import("plotly.js-basic-dist-min").then(
      (mod) => (mod as { default?: PlotlyApi }).default ?? (mod as unknown as PlotlyApi),
    );
  }
  return plotlyPromise;
}

// Inverse of `zonedDateString` for the purposes of comparison only. Treats
// the wall-clock string as UTC so the returned ms is offset by whatever the
// display timezone was — which is fine because both sides of any comparison
// go through this same function, so the offset cancels. Using this rather
// than raw string comparison protects against a future change to
// `zonedDateString`'s format (e.g. adding a weekday prefix) silently
// breaking chronological ordering.
function zonedDateStringMs(s: string): number {
  return Date.parse(s.replace(" ", "T") + "Z");
}

// Plotly renders date values literally (as if UTC), so feed it wall-clock
// strings for the chosen timezone to make the axis and hover read in that zone.
function zonedDateString(timestampMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestampMs));

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const hour = map.hour === "24" ? "00" : map.hour;
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}:${map.second}`;
}

function MetricChart({
  readings,
  metric,
  useFahrenheit,
  timezone,
  viewKey,
  xAxisRange,
  onXRangeChange,
  officialSeries,
}: {
  readings: Reading[];
  metric: "temperature" | "humidity";
  useFahrenheit: boolean;
  timezone: string;
  viewKey: string;
  xAxisRange?: [string, string] | null;
  onXRangeChange?: (range: [string, string] | null) => void;
  // Reference line from Open-Meteo history, shown on both the temperature
  // and humidity charts; absent/empty whenever there's no history yet.
  officialSeries?: { timestampMs: number; temperature: number; humidity: number }[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isTemp = metric === "temperature";
  const isDark = useDarkMode();
  // Tracks the last range we either sent to the parent or applied from it,
  // so we can break the relayout feedback loop between the two charts.
  const lastAppliedRange = useRef<string | null>(null);
  const onXRangeChangeRef = useRef(onXRangeChange);
  useEffect(() => { onXRangeChangeRef.current = onXRangeChange; });

  const chartReadings = useMemo(
    () =>
      readings
        .filter((r) => r.timestampMs)
        .slice()
        .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0)),
    [readings],
  );

  const deviceIds = useMemo(
    () => Array.from(new Set(chartReadings.map((r) => r.deviceId))).sort(),
    [chartReadings],
  );

  const hasEnough = chartReadings.length >= 2;

  useEffect(() => {
    if (!containerRef.current || !hasEnough) return;

    let cancelled = false;
    const tempUnit = useFahrenheit ? "°F" : "°C";
    const multiDevice = deviceIds.length > 1;

    const palette = (isTemp ? TEMP_COLORS : HUMIDITY_COLORS)[isDark ? "dark" : "light"];
    const singleFill = (isTemp ? TEMP_FILL : HUMIDITY_FILL)[isDark ? "dark" : "light"];

    const allValues: number[] = [];
    const data: Data[] = deviceIds.map((deviceId, idx) => {
      // Gaps are detected per-device: mixing two devices' own cadences
      // would misdetect gaps against the wrong sensor's posting interval.
      const deviceReadings = chartReadings.filter((r) => r.deviceId === deviceId);
      const ts = deviceReadings.map((r) => r.timestampMs ?? 0);
      const dts: number[] = [];
      for (let i = 1; i < ts.length; i++) dts.push(ts[i] - ts[i - 1]);
      const sortedDts = dts.slice().sort((a, b) => a - b);
      const medianDt =
        sortedDts.length > 0 ? sortedDts[Math.floor(sortedDts.length / 2)] : POST_INTERVAL_MS;
      const gapThreshold = Math.max(3 * medianDt, 3 * POST_INTERVAL_MS);

      const x: string[] = [];
      const y: (number | null)[] = [];
      const markerSize: number[] = [];

      for (let i = 0; i < deviceReadings.length; i++) {
        const r = deviceReadings[i];
        const t = ts[i];
        const prevGap = i > 0 && t - ts[i - 1] > gapThreshold;
        const nextGap = i + 1 < ts.length && ts[i + 1] - t > gapThreshold;
        const value = isTemp
          ? useFahrenheit
            ? toFahrenheit(r.temperature)
            : r.temperature
          : r.humidity;

        x.push(zonedDateString(t, timezone));
        y.push(value);
        markerSize.push(prevGap || nextGap ? 5 : 0);
        allValues.push(value);

        if (nextGap) {
          x.push(zonedDateString((t + ts[i + 1]) / 2, timezone));
          y.push(null);
          markerSize.push(0);
        }
      }

      const color = palette[idx % palette.length];
      // With one device the hover box's own trace-name label is redundant
      // (it's the only line); with two+ it disambiguates which is which.
      const hoverFmt = multiDevice
        ? (isTemp ? `%{y:.1f}${tempUnit}` : "%{y:.1f}%")
        : (isTemp ? `%{y:.1f}${tempUnit}<extra></extra>` : "%{y:.1f}%<extra></extra>");

      return {
        type: "scatter",
        mode: "lines+markers",
        name: deviceId,
        x,
        y,
        line: { color, width: 2.5, shape: "linear" },
        marker: { color, size: markerSize },
        fill: multiDevice ? "none" : "tozeroy",
        fillcolor: multiDevice ? undefined : singleFill,
        hovertemplate: hoverFmt,
      };
    });

    const hasOfficial = !!officialSeries && officialSeries.length > 0;
    if (hasOfficial) {
      const officialColor = OFFICIAL_COLOR[isDark ? "dark" : "light"];
      const officialValues = officialSeries!.map((p) =>
        isTemp ? (useFahrenheit ? toFahrenheit(p.temperature) : p.temperature) : p.humidity,
      );
      allValues.push(...officialValues);
      data.push({
        type: "scatter",
        mode: "lines",
        name: "Official",
        x: officialSeries!.map((p) => zonedDateString(p.timestampMs, timezone)),
        y: officialValues,
        line: { color: officialColor, width: 1.5, dash: "dot", shape: "linear" },
        hovertemplate: isTemp ? `%{y:.1f}${tempUnit}` : "%{y:.1f}%",
      });
    }

    const yMin = allValues.length
      ? isTemp
        ? Math.min(...allValues) - 1
        : Math.max(0, Math.min(...allValues) - 5)
      : 0;
    const yMax = allValues.length
      ? isTemp
        ? Math.max(...allValues) + 1
        : Math.min(100, Math.max(...allValues) + 5)
      : 100;

    const gridColor = isDark ? "#2a3a4a" : "#eef2f4";
    const axisColor = isDark ? "#3a4f63" : "#b8c3cc";
    const fontColor = isDark ? "#7a8fa3" : "#607080";
    const hoverBg = isDark ? "#19232e" : "#ffffff";
    const hoverBorder = isDark ? "#2a3a4a" : "#d8e0e6";
    const hoverFont = isDark ? "#e2e8ef" : "#182027";

    const layout: Partial<Layout> = {
      autosize: true,
      height: 280,
      uirevision: `${useFahrenheit ? "f" : "c"}|${timezone}|${viewKey}`,
      margin: { l: 56, r: 24, t: multiDevice || hasOfficial ? 32 : 12, b: 44 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, ui-sans-serif, system-ui, sans-serif", size: 12, color: fontColor },
      hovermode: "x unified",
      hoverlabel: { bgcolor: hoverBg, bordercolor: hoverBorder, font: { color: hoverFont } },
      showlegend: multiDevice || hasOfficial,
      legend: { orientation: "h", y: 1.12, font: { color: fontColor, size: 11 } },
      xaxis: {
        type: "date",
        hoverformat: "%b %d, %H:%M",
        gridcolor: gridColor,
        linecolor: axisColor,
        tickcolor: axisColor,
        zeroline: false,
      },
      yaxis: {
        tickfont: { color: multiDevice ? fontColor : palette[0] },
        range: [yMin, yMax],
        gridcolor: gridColor,
        zeroline: false,
      },
    };

    const config: Partial<Config> = {
      responsive: true,
      displaylogo: false,
      scrollZoom: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
    };

    loadPlotly().then((Plotly) => {
      if (cancelled || !containerRef.current) return;
      Plotly.react(containerRef.current, data, layout, config);

      // Attach x-axis sync listener, replacing any stale one from a prior render.
      const plotlyEl = containerRef.current as PlotlyEventDiv;
      plotlyEl.removeAllListeners("plotly_relayout");
      plotlyEl.on("plotly_relayout", (eventData: Record<string, unknown>) => {
        if (eventData["xaxis.range[0]"] !== undefined) {
          const range: [string, string] = [
            normalizeAxisValue(eventData["xaxis.range[0]"]),
            normalizeAxisValue(eventData["xaxis.range[1]"]),
          ];
          const rangeStr = JSON.stringify(range);
          if (rangeStr !== lastAppliedRange.current) {
            lastAppliedRange.current = rangeStr;
            onXRangeChangeRef.current?.(range);
          }
        } else if (eventData["xaxis.autorange"] === true) {
          if (lastAppliedRange.current !== null) {
            lastAppliedRange.current = null;
            onXRangeChangeRef.current?.(null);
          }
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [chartReadings, deviceIds, hasEnough, isDark, isTemp, useFahrenheit, timezone, viewKey, officialSeries]);

  // Apply an x-axis range received from the sibling chart.
  useEffect(() => {
    if (!containerRef.current) return;
    const rangeStr = xAxisRange ? JSON.stringify(xAxisRange) : null;
    if (rangeStr === lastAppliedRange.current) return;
    lastAppliedRange.current = rangeStr;
    loadPlotly().then((Plotly) => {
      if (!containerRef.current) return;
      if (xAxisRange) {
        Plotly.relayout(containerRef.current, {
          "xaxis.range[0]": xAxisRange[0],
          "xaxis.range[1]": xAxisRange[1],
          "xaxis.autorange": false,
        } as unknown as Partial<Layout>);
      } else {
        Plotly.relayout(containerRef.current, {
          "xaxis.autorange": true,
        } as unknown as Partial<Layout>);
      }
    });
  }, [xAxisRange]);

  useEffect(() => {
    const element = containerRef.current;
    return () => {
      if (element && plotlyPromise) {
        plotlyPromise.then((Plotly) => Plotly.purge(element));
      }
    };
  }, []);

  return (
    <div className="chart-shell">
      <div ref={containerRef} style={{ minHeight: 280, display: hasEnough ? "block" : "none" }} />
      {hasEnough ? null : (
        <div className="empty-panel">Waiting for enough timestamped readings.</div>
      )}
    </div>
  );
}

function ScatterRate({
  label,
  value,
  unit,
  colorClass,
}: {
  label: string;
  value: number | null;
  unit: string;
  colorClass: string;
}) {
  if (value === null) return null;
  const arrow = value > 0.001 ? "▲" : value < -0.001 ? "▼" : "→";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`scatter-rate ${colorClass}`}>
      <span className="rate-label">{label}</span>
      <span className="rate-arrow">{arrow}</span>
      <span className="rate-value">{sign}{value.toFixed(3)}</span>
      <span className="rate-unit">{unit}</span>
    </span>
  );
}

function ScatterChart({
  readings,
  useFahrenheit,
  timezone,
  viewKey,
  xAxisRange,
}: {
  readings: Reading[];
  useFahrenheit: boolean;
  timezone: string;
  viewKey: string;
  xAxisRange?: [string, string] | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const [animFrame, setAnimFrame] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Track the phone breakpoint so the colorbar moves out of the way of the
  // plot area instead of squeezing it on narrow screens.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 680px)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // This chart plots one continuous chronological trajectory (colored by
  // time, animated as a single path) — that concept doesn't extend to
  // multiple devices without a much larger redesign, so it's disabled
  // rather than plotting a path that zigzags between two sensors.
  const multiDevice = useMemo(
    () => new Set(readings.map((r) => r.deviceId)).size > 1,
    [readings],
  );

  // Drop rows without timestamps; also filter to the zoomed time window when set.
  // Sort oldest-first so the animation plays in chronological order.
  const points = useMemo(() => {
    const start = xAxisRange ? zonedDateStringMs(xAxisRange[0]) : null;
    const end = xAxisRange ? zonedDateStringMs(xAxisRange[1]) : null;
    return readings
      .filter((r) => {
        if (r.timestampMs == null) return false;
        if (start === null || end === null) return true;
        const t = zonedDateStringMs(zonedDateString(r.timestampMs, timezone));
        return t >= start && t <= end;
      })
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  }, [readings, xAxisRange, timezone]);

  // Reset animation whenever the underlying points change.
  useEffect(() => {
    setAnimFrame(null);
    setIsPlaying(false);
  }, [points]);

  // Advance the animation frame on a 50 ms interval (~20 fps).
  useEffect(() => {
    if (!isPlaying) return;
    const step = Math.max(1, Math.ceil(points.length / 150));
    const id = setInterval(() => {
      setAnimFrame((prev) => {
        const next = (prev ?? 0) + step;
        if (next >= points.length) {
          setIsPlaying(false);
          return null; // snap to "show all" when finished
        }
        return next;
      });
    }, 50);
    return () => clearInterval(id);
  }, [isPlaying, points.length]);

  const hasEnough = points.length >= 2 && !multiDevice;
  const isDark = useDarkMode();

  // Slice to the current animation frame, or use all points when idle.
  const displayPoints = useMemo(
    () => (animFrame === null ? points : points.slice(0, Math.max(2, animFrame))),
    [points, animFrame],
  );

  const tempUnit = useFahrenheit ? "°F" : "°C";

  const tempRate = useMemo(() => {
    if (displayPoints.length < 2) return null;
    return ratePerMinute(
      displayPoints.map((r) => r.timestampMs as number),
      displayPoints.map((r) => (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature)),
    );
  }, [displayPoints, useFahrenheit]);

  const humRate = useMemo(() => {
    if (displayPoints.length < 2) return null;
    return ratePerMinute(
      displayPoints.map((r) => r.timestampMs as number),
      displayPoints.map((r) => r.humidity),
    );
  }, [displayPoints]);

  useEffect(() => {
    if (!containerRef.current || !hasEnough) return;
    if (displayPoints.length < 2) return;

    let cancelled = false;

    // Keep axis ranges fixed to the full dataset so the viewport doesn't jump.
    const allTemps = points.map((r) => (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature));
    const allHums = points.map((r) => r.humidity);
    const allTimes = points.map((r) => r.timestampMs as number);

    const temps = displayPoints.map((r) => (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature));
    const hums = displayPoints.map((r) => r.humidity);
    const times = displayPoints.map((r) => r.timestampMs as number);

    const tempMin = Math.min(...allTemps) - 1;
    const tempMax = Math.max(...allTemps) + 1;
    const humMin = Math.max(0, Math.min(...allHums) - 5);
    const humMax = Math.min(100, Math.max(...allHums) + 5);

    const fontColor = isDark ? "#7a8fa3" : "#607080";
    const gridColor = isDark ? "#2a3a4a" : "#eef2f4";
    const axisColor = isDark ? "#3a4f63" : "#b8c3cc";
    const hoverBg = isDark ? "#19232e" : "#ffffff";
    const hoverBorder = isDark ? "#2a3a4a" : "#d8e0e6";
    const hoverFont = isDark ? "#e2e8ef" : "#182027";
    const tempAxisColor = isDark ? "#f97316" : "#c2410c";
    const humAxisColor = isDark ? "#38bdf8" : "#087ea4";

    const shortDate = (t: number) =>
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "2-digit" })
        .format(new Date(t));
    const fullDate = (t: number) => zonedDateString(t, timezone).slice(0, 16);

    const data: Data[] = [
      {
        type: "scatter",
        mode: "markers",
        x: hums,
        y: temps,
        marker: {
          size: 6,
          color: times,
          colorscale: "Viridis",
          cmin: allTimes[0],
          cmax: allTimes[allTimes.length - 1],
          showscale: true,
          colorbar: isNarrow
            ? {
                orientation: "h",
                x: 0.5,
                xanchor: "center",
                y: -0.22,
                yanchor: "top",
                len: 0.8,
                thickness: 8,
                tickfont: { color: fontColor, size: 11 },
                tickmode: "array",
                tickvals: [allTimes[0], allTimes[allTimes.length - 1]],
                ticktext: [shortDate(allTimes[0]), shortDate(allTimes[allTimes.length - 1])],
              }
            : {
                title: { text: "Time", font: { color: fontColor } },
                tickfont: { color: fontColor },
                tickmode: "array",
                tickvals: [allTimes[0], allTimes[allTimes.length - 1]],
                ticktext: [fullDate(allTimes[0]), fullDate(allTimes[allTimes.length - 1])],
                thickness: 12,
              },
          line: { width: 0 },
        },
        customdata: times.map((t) => zonedDateString(t, timezone)),
        hovertemplate: `%{x:.1f}%% RH, %{y:.1f}${tempUnit}<br>%{customdata}<extra></extra>`,
      },
    ];

    const layout: Partial<Layout> = {
      autosize: true,
      height: isNarrow ? 380 : 460,
      uirevision: `${useFahrenheit ? "f" : "c"}|${timezone}|${viewKey}`,
      margin: isNarrow
        ? { l: 44, r: 12, t: 12, b: 70 }
        : { l: 56, r: 24, t: 16, b: 48 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, ui-sans-serif, system-ui, sans-serif", size: 12, color: fontColor },
      hovermode: "closest",
      hoverlabel: { bgcolor: hoverBg, bordercolor: hoverBorder, font: { color: hoverFont } },
      xaxis: {
        title: { text: "Humidity (%)", font: { color: humAxisColor } },
        range: [humMin, humMax],
        gridcolor: gridColor,
        linecolor: axisColor,
        tickcolor: axisColor,
        zeroline: false,
      },
      yaxis: {
        title: { text: `Temperature (${tempUnit})`, font: { color: tempAxisColor } },
        range: [tempMin, tempMax],
        gridcolor: gridColor,
        linecolor: axisColor,
        tickcolor: axisColor,
        zeroline: false,
      },
    };

    const config: Partial<Config> = {
      responsive: true,
      displaylogo: false,
      scrollZoom: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
    };

    loadPlotly().then((Plotly) => {
      if (cancelled || !containerRef.current) return;
      Plotly.react(containerRef.current, data, layout, config);
    });

    return () => {
      cancelled = true;
    };
  }, [displayPoints, points, hasEnough, isDark, useFahrenheit, timezone, viewKey, isNarrow]);

  useEffect(() => {
    const element = containerRef.current;
    return () => {
      if (element && plotlyPromise) {
        plotlyPromise.then((Plotly) => Plotly.purge(element));
      }
    };
  }, []);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      if (animFrame === null) setAnimFrame(0); // start from beginning
      setIsPlaying(true);
    }
  }, [isPlaying, animFrame]);

  const handleReset = useCallback(() => {
    setIsPlaying(false);
    setAnimFrame(null);
  }, []);

  const progress = animFrame === null ? points.length : animFrame;

  return (
    <div className="chart-shell">
      <div
        ref={containerRef}
        style={{ minHeight: isNarrow ? 380 : 460, display: hasEnough ? "block" : "none" }}
      />
      {hasEnough ? null : multiDevice ? (
        <div className="empty-panel">Select a specific device (above) to see this chart.</div>
      ) : (
        <div className="empty-panel">Waiting for enough timestamped readings.</div>
      )}
      {hasEnough ? (
        <>
        <div className="scatter-controls">
          <button
            className="scatter-play-btn"
            type="button"
            onClick={handlePlayPause}
            aria-label={isPlaying ? "Pause animation" : "Play animation"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <div className="scatter-progress-track">
            <div
              className="scatter-progress-fill"
              style={{ width: `${(progress / points.length) * 100}%` }}
            />
          </div>
          <span className="scatter-progress-label">
            {progress} / {points.length}
          </span>
          {animFrame !== null ? (
            <button
              className="scatter-reset-btn"
              type="button"
              onClick={handleReset}
              aria-label="Reset animation"
            >
              ⟳
            </button>
          ) : null}
        </div>
        <div className="scatter-rates">
          <ScatterRate label="Temp" value={tempRate} unit={`°${tempUnit}/min`} colorClass="rate-temp" />
          <ScatterRate label="Humidity" value={humRate} unit="%/min" colorClass="rate-humidity" />
        </div>
        </>
      ) : null}
    </div>
  );
}

function StatusCard({
  currentTempC,
  humidity,
  useFahrenheit,
  tempTrend = null,
  humidityTrend = null,
  official = null,
  timezone,
}: {
  currentTempC: number | null;
  humidity: number | null;
  useFahrenheit: boolean;
  tempTrend?: Trend;
  humidityTrend?: Trend;
  official?: { temperature: number; humidity: number; observedAt: string } | null;
  timezone: string;
}) {
  const tempUnit = useFahrenheit ? "F" : "C";
  const displayTemp =
    currentTempC === null
      ? null
      : useFahrenheit
        ? toFahrenheit(currentTempC)
        : currentTempC;
  const heatC = currentTempC === null || humidity === null ? null : heatIndexCelsius(currentTempC, humidity);
  const displayHeat =
    heatC === null ? null : useFahrenheit ? toFahrenheit(heatC) : heatC;

  const dewPointC =
    currentTempC === null || humidity === null ? null : dewPointCelsius(currentTempC, humidity);
  const displayDewPoint =
    dewPointC === null ? null : useFahrenheit ? toFahrenheit(dewPointC) : dewPointC;
  const absHumidity =
    currentTempC === null || humidity === null ? null : absoluteHumidity(currentTempC, humidity);

  const displayOfficialTemp =
    official === null ? null : useFahrenheit ? toFahrenheit(official.temperature) : official.temperature;
  // Delta is computed in Celsius first, then scaled — converting each side
  // to °F independently and subtracting would double-apply the +32 offset.
  const officialDeltaC = currentTempC === null || official === null ? null : currentTempC - official.temperature;
  const displayOfficialDelta =
    officialDeltaC === null ? null : useFahrenheit ? toFahrenheitDelta(officialDeltaC) : officialDeltaC;
  const officialHumidityDelta =
    humidity === null || official === null ? null : humidity - official.humidity;
  const officialObservedLabel =
    official === null
      ? null
      : new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(
          new Date(official.observedAt),
        );

  // Clamp the marker so it sits inside the gauge for any input.
  const markerPct = humidity === null ? null : Math.max(0, Math.min(100, humidity));

  return (
    <section className="status-card">
      <div className="status-metrics">
        <div className="status-metric temp">
          <div className="status-value">
            {displayTemp === null ? "--" : `${formatNumber(displayTemp)}°${tempUnit}`}
            <TrendArrow trend={tempTrend} />
          </div>
          <div className="status-label">Temperature</div>
        </div>
        <div className="status-divider" />
        <div className="status-metric heat">
          <div className="status-value">
            {displayHeat === null ? "--" : `${formatNumber(displayHeat)}°${tempUnit}`}
          </div>
          <div className="status-label">Heat Index</div>
        </div>
        <div className="status-divider" />
        <div className="status-metric humidity">
          <div className="status-value">
            {humidity === null ? "--" : `${formatNumber(humidity)}%`}
            <TrendArrow trend={humidityTrend} />
          </div>
          <div className="status-label">Humidity</div>
        </div>
      </div>
      <div className="comfort-gauge">
        <div className="comfort-bar" />
        {markerPct !== null ? (
          <div className="comfort-marker" style={{ left: `${markerPct}%` }} aria-hidden="true" />
        ) : null}
        <div className="comfort-labels">
          <span className="comfort-dry">Dry</span>
          <span className="comfort-comfort">Comfort</span>
          <span className="comfort-wet">Wet</span>
        </div>
      </div>
      <div className="extra-metrics">
        <span>
          <span className="extra-metric-label">Dew point</span>{" "}
          {displayDewPoint === null ? "--" : `${formatNumber(displayDewPoint)}°${tempUnit}`}
        </span>
        <span>
          <span className="extra-metric-label">Absolute humidity</span>{" "}
          {absHumidity === null ? "--" : `${formatNumber(absHumidity)} g/m³`}
        </span>
        {official !== null ? (
          <>
            <span title={officialObservedLabel ? `Open-Meteo, as of ${officialObservedLabel}` : "Open-Meteo"}>
              <span className="extra-metric-label">Official temp</span>{" "}
              {displayOfficialTemp === null ? "--" : `${formatNumber(displayOfficialTemp)}°${tempUnit}`}
              {displayOfficialDelta === null
                ? ""
                : ` (${displayOfficialDelta > 0 ? "+" : ""}${formatNumber(displayOfficialDelta)}°${tempUnit} vs sensor)`}
            </span>
            <span title={officialObservedLabel ? `Open-Meteo, as of ${officialObservedLabel}` : "Open-Meteo"}>
              <span className="extra-metric-label">Official humidity</span>{" "}
              {formatNumber(official.humidity)}%
              {officialHumidityDelta === null
                ? ""
                : ` (${officialHumidityDelta > 0 ? "+" : ""}${formatNumber(officialHumidityDelta)}% vs sensor)`}
            </span>
          </>
        ) : null}
      </div>
    </section>
  );
}

export default function Page() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState("all");
  const [rangeHours, setRangeHours] = useState<number | null>(24);
  const [useFahrenheit, setUseFahrenheit] = useState(false);
  const [timezone, setTimezone] = useState(process.env.NEXT_PUBLIC_DASHBOARD_TIMEZONE || "Europe/Paris");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sharedXRange, setSharedXRange] = useState<[string, string] | null>(null);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [weatherHistory, setWeatherHistory] = useState<
    { timestampMs: number; temperature: number; humidity: number }[]
  >([]);

  const handleXRangeChange = useCallback((range: [string, string] | null) => {
    setSharedXRange(range);
  }, []);

  const viewKey = `${rangeHours ?? "all"}|${device}`;

  // Reset the shared zoom whenever the data window or timezone changes.
  useEffect(() => {
    setSharedXRange(null);
  }, [viewKey, timezone]);

  // The server windows + downsamples based on `range_hours`, so the payload
  // size scales with the selected range instead of always being 5000 rows.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rangeParam = rangeHours === null ? "all" : String(rangeHours);
      const response = await fetch(`/api/readings?range_hours=${rangeParam}`, { cache: "no-store" });
      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "Could not load readings" : payload.error);
      }
      setData(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load readings");
    } finally {
      setLoading(false);
    }
  }, [rangeHours]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(refresh, 30000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh]);

  // Separate from the readings poll above: the API route caches Open-Meteo
  // responses for several minutes, so polling every 30s like the readings
  // endpoint would just re-request the same cached value. A failure here is
  // non-critical (the comparison simply disappears), so it's swallowed
  // rather than surfaced through the same `error` banner as readings.
  const refreshWeather = useCallback(async () => {
    try {
      const rangeParam = rangeHours === null ? "all" : String(rangeHours);
      const [current, history] = await Promise.all([
        fetch("/api/weather", { cache: "no-store" }).then((r) => r.json() as Promise<WeatherResponse>),
        fetch(`/api/weather/history?range_hours=${rangeParam}`, { cache: "no-store" }).then(
          (r) => r.json() as Promise<WeatherHistoryResponse>,
        ),
      ]);
      setWeather(current);
      if (history.ok) {
        setWeatherHistory(
          history.points
            .map((p) => ({ timestampMs: Date.parse(p.observedAt), temperature: p.temperature, humidity: p.humidity }))
            .filter((p) => Number.isFinite(p.timestampMs)),
        );
      }
    } catch {
      // Keep whatever was last loaded.
    }
  }, [rangeHours]);

  useEffect(() => {
    refreshWeather();
    const interval = window.setInterval(refreshWeather, 5 * 60000);
    return () => window.clearInterval(interval);
  }, [refreshWeather]);

  const official = weather?.ok && weather.configured ? weather : null;

  const readings = data?.ok ? data.readings : [];
  const devices = useMemo(() => {
    return Array.from(new Set(readings.map((reading) => reading.deviceId))).sort();
  }, [readings]);

  // The server already windows to `rangeHours`; here we only need to narrow
  // by device. The time cutoff that used to live here was a leftover from the
  // pre-server-windowing days and would drift with `Date.now()` across
  // re-renders while adding nothing on top of the fetched payload.
  const filtered = useMemo(() => {
    if (device === "all") return readings;
    return readings.filter((reading) => reading.deviceId === device);
  }, [device, readings]);

  const latest = filtered[0];
  const tempUnit = useFahrenheit ? "F" : "C";

  // One card per device when viewing "All devices" with more than one
  // present, instead of a single ambiguous "latest reading from whichever
  // device happened to post most recently" value.
  const latestByDevice = useMemo(() => {
    const map = new Map<string, Reading>();
    for (const reading of filtered) {
      if (!map.has(reading.deviceId)) map.set(reading.deviceId, reading);
    }
    return map;
  }, [filtered]);
  const showPerDeviceStatus = device === "all" && devices.length > 1;

  // Per-device trend (last 10 min), independent of the device filter above
  // so it stays available regardless of which device's chart is showing.
  const trendByDevice = useMemo(() => {
    const cutoff = Date.now() - TREND_WINDOW_MS;
    const recentByDevice = new Map<string, Reading[]>();
    for (const reading of readings) {
      if (reading.timestampMs === null || reading.timestampMs < cutoff) continue;
      const list = recentByDevice.get(reading.deviceId) ?? [];
      list.push(reading);
      recentByDevice.set(reading.deviceId, list);
    }
    const map = new Map<string, { temp: Trend; humidity: Trend }>();
    for (const [deviceId, recent] of recentByDevice) {
      map.set(deviceId, deviceTrends(recent));
    }
    return map;
  }, [readings]);

  // Max/Min for each chart header. Computed in the displayed unit so the
  // labels match what the user sees in the chart.
  const tempStats = useMemo(() => {
    if (!filtered.length) return null;
    const values = filtered.map((r) => (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature));
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [filtered, useFahrenheit]);
  const humStats = useMemo(() => {
    if (!filtered.length) return null;
    const values = filtered.map((r) => r.humidity);
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [filtered]);

  // Newest reading for the selected device, ignoring the time-range filter, so
  // staleness is detected even when the chosen range hides an offline device.
  const newestForDevice = useMemo(() => {
    const pool = device === "all" ? readings : readings.filter((reading) => reading.deviceId === device);
    return pool.find((reading) => reading.timestampMs) ?? null;
  }, [device, readings]);
  const lastAgeMs =
    newestForDevice?.timestampMs != null ? Date.now() - newestForDevice.timestampMs : null;
  const isStale = lastAgeMs !== null && lastAgeMs > STALE_AFTER_MS;

  // `sheetTitle` doubles as a data-source tag: "Supabase" when reading from
  // the database, otherwise the Google Sheet's title.
  const dataSource = data?.ok ? (data.sheetTitle === "Supabase" ? "Supabase" : "Google Sheets") : null;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>ESP32 Weather Monitor</h1>
          <p>
            {latest ? `Last reading ${formatTime(latest, timezone)}` : "Waiting for readings"}
            {dataSource ? ` · Source: ${dataSource}` : ""}
          </p>
        </div>
        <button className="icon-button" type="button" onClick={refresh} disabled={loading} aria-label="Refresh data">
          <span aria-hidden="true">↻</span>
          Refresh
        </button>
      </header>

      <section className="controls" aria-label="Dashboard controls">
        <label>
          Device
          <select value={device} onChange={(event) => setDevice(event.target.value)}>
            <option value="all">All devices</option>
            {devices.map((deviceId) => (
              <option key={deviceId} value={deviceId}>
                {deviceId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Range
          <select
            value={rangeHours ?? "all"}
            onChange={(event) => setRangeHours(event.target.value === "all" ? null : Number(event.target.value))}
          >
            {RANGES.map((range) => (
              <option key={range.label} value={range.hours ?? "all"}>
                {range.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Timezone
          <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={useFahrenheit} onChange={(event) => setUseFahrenheit(event.target.checked)} />
          Fahrenheit
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
          Auto-refresh
        </label>
      </section>

      {isStale && lastAgeMs !== null && newestForDevice ? (
        <div className="warning-banner" role="status">
          ⚠ No new readings for {formatAge(lastAgeMs)}
          {device !== "all" ? ` from ${device}` : ""} — the device may be offline.{" "}
          Last reading {formatTime(newestForDevice, timezone)}.
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      {showPerDeviceStatus ? (
        <div className="status-card-group">
          {devices.map((deviceId) => {
            const reading = latestByDevice.get(deviceId) ?? null;
            const trend = trendByDevice.get(deviceId);
            return (
              <div key={deviceId} className="status-card-item">
                <div className="status-card-item-label">{deviceId}</div>
                <StatusCard
                  currentTempC={reading ? reading.temperature : null}
                  humidity={reading ? reading.humidity : null}
                  useFahrenheit={useFahrenheit}
                  tempTrend={trend?.temp}
                  humidityTrend={trend?.humidity}
                  official={official}
                  timezone={timezone}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <StatusCard
          currentTempC={latest ? latest.temperature : null}
          humidity={latest ? latest.humidity : null}
          useFahrenheit={useFahrenheit}
          tempTrend={trendByDevice.get(latest?.deviceId ?? "")?.temp}
          humidityTrend={trendByDevice.get(latest?.deviceId ?? "")?.humidity}
          official={official}
          timezone={timezone}
        />
      )}

      <section className="panel chart-panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>Temperature (°{tempUnit})</h2>
          <span>
            {tempStats
              ? `Max: ${formatNumber(tempStats.max)}°${tempUnit}   Min: ${formatNumber(tempStats.min)}°${tempUnit}`
              : loading
                ? "Loading"
                : "--"}
          </span>
        </div>
        <MetricChart
          metric="temperature"
          readings={filtered}
          useFahrenheit={useFahrenheit}
          timezone={timezone}
          viewKey={viewKey}
          xAxisRange={sharedXRange}
          onXRangeChange={handleXRangeChange}
          officialSeries={weatherHistory}
        />
      </section>

      <section className="panel chart-panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>Humidity (%)</h2>
          <span>
            {humStats
              ? `Max: ${formatNumber(humStats.max)}%   Min: ${formatNumber(humStats.min)}%`
              : loading
                ? "Loading"
                : "--"}
          </span>
        </div>
        <MetricChart
          metric="humidity"
          readings={filtered}
          useFahrenheit={useFahrenheit}
          timezone={timezone}
          viewKey={viewKey}
          xAxisRange={sharedXRange}
          onXRangeChange={handleXRangeChange}
          officialSeries={weatherHistory}
        />
      </section>

      <section className="panel chart-panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>Temperature vs Humidity</h2>
          <span>{loading ? "Loading" : `${filtered.length} points`}</span>
        </div>
        <ScatterChart
          readings={filtered}
          useFahrenheit={useFahrenheit}
          timezone={timezone}
          viewKey={viewKey}
          xAxisRange={sharedXRange}
        />
      </section>

      <section className="panel table-panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>Recent Readings</h2>
          <span>
            {data?.ok && data.stride > 1
              ? `${data.sheetTitle} · every ${data.stride}th`
              : data?.ok
                ? data.sheetTitle
                : "Google Sheets"}
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Device</th>
                <th>Temp</th>
                <th>Humidity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 12).map((reading) => (
                <tr key={reading.id}>
                  <td>{formatTime(reading, timezone)}</td>
                  <td>{reading.deviceId}</td>
                  <td>{formatNumber(useFahrenheit ? toFahrenheit(reading.temperature) : reading.temperature)}°{tempUnit}</td>
                  <td>{formatNumber(reading.humidity)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length ? <div className="empty-panel">No readings match the selected filters.</div> : null}
        </div>
      </section>
    </main>
  );
}
