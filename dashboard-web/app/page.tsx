"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

function formatNumber(value: number, digits = 1) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function toFahrenheit(celsius: number) {
  return celsius * 1.8 + 32;
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

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function delta(current: number, previous?: number) {
  if (previous === undefined) return null;
  return current - previous;
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

function TrendChart({
  readings,
  useFahrenheit,
  timezone,
}: {
  readings: Reading[];
  useFahrenheit: boolean;
  timezone: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const chartReadings = useMemo(
    () =>
      readings
        .filter((reading) => reading.timestampMs)
        .slice()
        .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0)),
    [readings],
  );

  const hasEnough = chartReadings.length >= 2;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !hasEnough) return;

    let cancelled = false;
    const tempUnit = useFahrenheit ? "°F" : "°C";
    const x = chartReadings.map((reading) => zonedDateString(reading.timestampMs ?? 0, timezone));
    const hums = chartReadings.map((reading) => reading.humidity);
    const humMin = Math.max(0, Math.min(...hums) - 5);
    const humMax = Math.min(100, Math.max(...hums) + 5);

    const data: Data[] = [
      {
        type: "scatter",
        mode: "lines",
        name: `Temperature (${tempUnit})`,
        x,
        y: chartReadings.map((reading) =>
          useFahrenheit ? toFahrenheit(reading.temperature) : reading.temperature,
        ),
        line: { color: "#c2410c", width: 2.5 },
        hovertemplate: `%{y:.1f}${tempUnit}<extra></extra>`,
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Humidity (%)",
        x,
        y: hums,
        line: { color: "#087ea4", width: 2.5 },
        hovertemplate: "%{y:.1f}%<extra></extra>",
        yaxis: "y2",
      },
    ];

    const layout: Partial<Layout> = {
      autosize: true,
      height: 460,
      // Keep zoom/pan across the 30s auto-refresh; reset only on unit/tz change.
      uirevision: `${useFahrenheit ? "f" : "c"}|${timezone}`,
      margin: { l: 56, r: 24, t: 16, b: 44 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, ui-sans-serif, system-ui, sans-serif", size: 12, color: "#607080" },
      hovermode: "x unified",
      hoverlabel: { bgcolor: "#ffffff", bordercolor: "#d8e0e6", font: { color: "#182027" } },
      legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "left", x: 0 },
      // Single shared x-axis (anchored to the bottom subplot) so zooming x
      // applies to both panels at once.
      xaxis: {
        type: "date",
        anchor: "y2",
        hoverformat: "%b %d, %H:%M",
        gridcolor: "#eef2f4",
        linecolor: "#b8c3cc",
        tickcolor: "#b8c3cc",
        zeroline: false,
      },
      // Temperature panel (top).
      yaxis: {
        domain: [0.56, 1],
        title: { text: `Temperature (${tempUnit})`, font: { color: "#c2410c" } },
        tickfont: { color: "#c2410c" },
        gridcolor: "#eef2f4",
        zeroline: false,
      },
      // Humidity panel (bottom).
      yaxis2: {
        domain: [0, 0.44],
        title: { text: "Humidity (%)", font: { color: "#087ea4" } },
        tickfont: { color: "#087ea4" },
        range: [humMin, humMax],
        gridcolor: "#eef2f4",
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
  }, [chartReadings, hasEnough, useFahrenheit, timezone]);

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
      <div ref={containerRef} style={{ minHeight: 460, display: hasEnough ? "block" : "none" }} />
      {hasEnough ? null : (
        <div className="empty-panel">Waiting for enough timestamped readings.</div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "temp" | "humidity" | "neutral";
}) {
  return (
    <section className={`metric-card ${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
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

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/readings?limit=5000", { cache: "no-store" });
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
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(refresh, 30000);
    return () => window.clearInterval(interval);
  }, [autoRefresh]);

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
  const previous = filtered[1];
  const currentTemp = latest ? (useFahrenheit ? toFahrenheit(latest.temperature) : latest.temperature) : null;
  const previousTemp = previous ? (useFahrenheit ? toFahrenheit(previous.temperature) : previous.temperature) : undefined;
  const tempDelta = currentTemp === null ? null : delta(currentTemp, previousTemp);
  const humidityDelta = latest ? delta(latest.humidity, previous?.humidity) : null;
  const avgTempC = average(filtered.map((reading) => reading.temperature));
  const avgHumidity = average(filtered.map((reading) => reading.humidity));
  const tempUnit = useFahrenheit ? "F" : "C";

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

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="metrics">
        <MetricCard
          label="Temperature"
          value={currentTemp === null ? "--" : `${formatNumber(currentTemp)}°${tempUnit}`}
          detail={tempDelta === null ? "No prior reading" : `${tempDelta >= 0 ? "+" : ""}${formatNumber(tempDelta)}°${tempUnit}`}
          tone="temp"
        />
        <MetricCard
          label="Humidity"
          value={latest ? `${formatNumber(latest.humidity)}%` : "--"}
          detail={humidityDelta === null ? "No prior reading" : `${humidityDelta >= 0 ? "+" : ""}${formatNumber(humidityDelta)}%`}
          tone="humidity"
        />
        <MetricCard
          label="Average Temperature"
          value={avgTempC === null ? "--" : `${formatNumber(useFahrenheit ? toFahrenheit(avgTempC) : avgTempC)}°${tempUnit}`}
          detail={`${filtered.length} readings`}
          tone="neutral"
        />
        <MetricCard
          label="Average Humidity"
          value={avgHumidity === null ? "--" : `${formatNumber(avgHumidity)}%`}
          detail={data?.ok ? `${data.rowsLoaded} sheet rows` : "Sheet unavailable"}
          tone="neutral"
        />
      </section>

      <section className="main-grid">
        <section className="panel chart-panel">
          <div className="panel-header">
            <h2>Trend</h2>
            <span>{loading ? "Loading" : `${filtered.length} readings`}</span>
          </div>
          <TrendChart readings={filtered} useFahrenheit={useFahrenheit} timezone={timezone} />
        </section>

        <section className="panel table-panel">
          <div className="panel-header">
            <h2>Recent Readings</h2>
            <span>{data?.ok ? data.sheetTitle : "Google Sheets"}</span>
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
      </section>
    </main>
  );
}
