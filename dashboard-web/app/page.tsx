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
  { label: "7d", hours: 168 },
  { label: "All", hours: null },
];

// Cadence the ESP32 firmware posts at (BASE_INTERVAL_MS). Drives both the
// staleness threshold and the chart-gap detection floor.
const POST_INTERVAL_MS = 60 * 1000;
// Warn when the newest reading is older than ~5 missed posts.
const STALE_AFTER_MS = 5 * POST_INTERVAL_MS;

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

type PlotlyApi = typeof import("plotly.js");

let plotlyPromise: Promise<PlotlyApi> | null = null;

function loadPlotly(): Promise<PlotlyApi> {
  if (!plotlyPromise) {
    plotlyPromise = import("plotly.js-basic-dist-min").then(
      (mod) => (mod as { default?: PlotlyApi }).default ?? (mod as unknown as PlotlyApi),
    );
  }
  return plotlyPromise;
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
}: {
  readings: Reading[];
  metric: "temperature" | "humidity";
  useFahrenheit: boolean;
  timezone: string;
  viewKey: string;
  xAxisRange?: [string, string] | null;
  onXRangeChange?: (range: [string, string] | null) => void;
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

  const hasEnough = chartReadings.length >= 2;

  useEffect(() => {
    if (!containerRef.current || !hasEnough) return;

    let cancelled = false;
    const tempUnit = useFahrenheit ? "°F" : "°C";

    const ts = chartReadings.map((r) => r.timestampMs ?? 0);
    const dts: number[] = [];
    for (let i = 1; i < ts.length; i++) dts.push(ts[i] - ts[i - 1]);
    const sortedDts = dts.slice().sort((a, b) => a - b);
    const medianDt =
      sortedDts.length > 0 ? sortedDts[Math.floor(sortedDts.length / 2)] : POST_INTERVAL_MS;
    const gapThreshold = Math.max(3 * medianDt, 3 * POST_INTERVAL_MS);

    const x: string[] = [];
    const y: (number | null)[] = [];
    const markerSize: number[] = [];

    for (let i = 0; i < chartReadings.length; i++) {
      const r = chartReadings[i];
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

      if (nextGap) {
        x.push(zonedDateString((t + ts[i + 1]) / 2, timezone));
        y.push(null);
        markerSize.push(0);
      }
    }

    const validY = y.filter((v): v is number => v !== null);
    const yMin = validY.length
      ? isTemp
        ? Math.min(...validY) - 1
        : Math.max(0, Math.min(...validY) - 5)
      : 0;
    const yMax = validY.length
      ? isTemp
        ? Math.max(...validY) + 1
        : Math.min(100, Math.max(...validY) + 5)
      : 100;

    const lineColor = isDark
      ? isTemp ? "#f97316" : "#38bdf8"
      : isTemp ? "#c2410c" : "#087ea4";
    const fillColor = isDark
      ? isTemp ? "rgba(249, 115, 22, 0.18)" : "rgba(56, 189, 248, 0.18)"
      : isTemp ? "rgba(194, 65, 12, 0.12)" : "rgba(8, 126, 164, 0.12)";
    const gridColor = isDark ? "#2a3a4a" : "#eef2f4";
    const axisColor = isDark ? "#3a4f63" : "#b8c3cc";
    const fontColor = isDark ? "#7a8fa3" : "#607080";
    const hoverBg = isDark ? "#19232e" : "#ffffff";
    const hoverBorder = isDark ? "#2a3a4a" : "#d8e0e6";
    const hoverFont = isDark ? "#e2e8ef" : "#182027";
    const hoverFmt = isTemp ? `%{y:.1f}${tempUnit}<extra></extra>` : "%{y:.1f}%<extra></extra>";

    const data: Data[] = [
      {
        type: "scatter",
        mode: "lines+markers",
        x,
        y,
        line: { color: lineColor, width: 2.5, shape: "linear" },
        marker: { color: lineColor, size: markerSize },
        fill: "tozeroy",
        fillcolor: fillColor,
        hovertemplate: hoverFmt,
      },
    ];

    const layout: Partial<Layout> = {
      autosize: true,
      height: 280,
      uirevision: `${useFahrenheit ? "f" : "c"}|${timezone}|${viewKey}`,
      margin: { l: 56, r: 24, t: 12, b: 44 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, ui-sans-serif, system-ui, sans-serif", size: 12, color: fontColor },
      hovermode: "x unified",
      hoverlabel: { bgcolor: hoverBg, bordercolor: hoverBorder, font: { color: hoverFont } },
      showlegend: false,
      xaxis: {
        type: "date",
        hoverformat: "%b %d, %H:%M",
        gridcolor: gridColor,
        linecolor: axisColor,
        tickcolor: axisColor,
        zeroline: false,
      },
      yaxis: {
        tickfont: { color: lineColor },
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plotlyEl = containerRef.current as unknown as any;
      plotlyEl.removeAllListeners("plotly_relayout");
      plotlyEl.on("plotly_relayout", (eventData: Record<string, unknown>) => {
        if (eventData["xaxis.range[0]"] !== undefined) {
          const range: [string, string] = [
            String(eventData["xaxis.range[0]"]),
            String(eventData["xaxis.range[1]"]),
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
  }, [chartReadings, hasEnough, isDark, isTemp, useFahrenheit, timezone, viewKey]);

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

  // Drop rows without timestamps; also filter to the zoomed time window when set.
  // Sort oldest-first so the animation plays in chronological order.
  const points = useMemo(() => {
    return readings
      .filter((r) => {
        if (r.timestampMs == null) return false;
        if (!xAxisRange) return true;
        const s = zonedDateString(r.timestampMs, timezone);
        return s >= xAxisRange[0] && s <= xAxisRange[1];
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

  const hasEnough = points.length >= 2;
  const isDark = useDarkMode();

  useEffect(() => {
    if (!containerRef.current || !hasEnough) return;

    // Slice to the current animation frame, or use all points when idle.
    const display = animFrame === null ? points : points.slice(0, Math.max(2, animFrame));
    if (display.length < 2) return;

    let cancelled = false;
    const tempUnit = useFahrenheit ? "°F" : "°C";

    // Keep axis ranges fixed to the full dataset so the viewport doesn't jump.
    const allTemps = points.map((r) => (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature));
    const allHums = points.map((r) => r.humidity);
    const allTimes = points.map((r) => r.timestampMs as number);

    const temps = display.map((r) => (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature));
    const hums = display.map((r) => r.humidity);
    const times = display.map((r) => r.timestampMs as number);

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
  }, [points, hasEnough, isDark, useFahrenheit, timezone, viewKey, isNarrow, animFrame]);

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
      {hasEnough ? null : (
        <div className="empty-panel">Waiting for enough timestamped readings.</div>
      )}
      {hasEnough ? (
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
      ) : null}
    </div>
  );
}

function StatusCard({
  currentTempC,
  humidity,
  useFahrenheit,
}: {
  currentTempC: number | null;
  humidity: number | null;
  useFahrenheit: boolean;
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

  // Clamp the marker so it sits inside the gauge for any input.
  const markerPct = humidity === null ? null : Math.max(0, Math.min(100, humidity));

  return (
    <section className="status-card">
      <div className="status-metrics">
        <div className="status-metric temp">
          <div className="status-value">
            {displayTemp === null ? "--" : `${formatNumber(displayTemp)}°${tempUnit}`}
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

  const readings = data?.ok ? data.readings : [];
  const devices = useMemo(() => {
    return Array.from(new Set(readings.map((reading) => reading.deviceId))).sort();
  }, [readings]);

  const filtered = useMemo(() => {
    const cutoff = rangeHours ? Date.now() - rangeHours * 60 * 60 * 1000 : null;
    return readings.filter((reading) => {
      if (device !== "all" && reading.deviceId !== device) return false;
      if (cutoff && reading.timestampMs && reading.timestampMs < cutoff) return false;
      return true;
    });
  }, [device, rangeHours, readings]);

  const latest = filtered[0];
  const tempUnit = useFahrenheit ? "F" : "C";

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

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>ESP32 Weather Monitor</h1>
          <p>{latest ? `Last reading ${formatTime(latest, timezone)}` : "Waiting for readings"}</p>
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

      <StatusCard
        currentTempC={latest ? latest.temperature : null}
        humidity={latest ? latest.humidity : null}
        useFahrenheit={useFahrenheit}
      />

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
