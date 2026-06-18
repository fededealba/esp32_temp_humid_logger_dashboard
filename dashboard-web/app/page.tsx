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
}: {
  readings: Reading[];
  metric: "temperature" | "humidity";
  useFahrenheit: boolean;
  timezone: string;
  viewKey: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isTemp = metric === "temperature";

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

    const lineColor = isTemp ? "#c2410c" : "#087ea4";
    const fillColor = isTemp ? "rgba(194, 65, 12, 0.12)" : "rgba(8, 126, 164, 0.12)";
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
      font: { family: "Inter, ui-sans-serif, system-ui, sans-serif", size: 12, color: "#607080" },
      hovermode: "x unified",
      hoverlabel: { bgcolor: "#ffffff", bordercolor: "#d8e0e6", font: { color: "#182027" } },
      showlegend: false,
      xaxis: {
        type: "date",
        hoverformat: "%b %d, %H:%M",
        gridcolor: "#eef2f4",
        linecolor: "#b8c3cc",
        tickcolor: "#b8c3cc",
        zeroline: false,
      },
      yaxis: {
        tickfont: { color: lineColor },
        range: [yMin, yMax],
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
  }, [chartReadings, hasEnough, isTemp, useFahrenheit, timezone, viewKey]);

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
}: {
  readings: Reading[];
  useFahrenheit: boolean;
  timezone: string;
  viewKey: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Drop rows without timestamps so the time-colormap stays meaningful.
  const points = useMemo(
    () => readings.filter((r) => r.timestampMs != null),
    [readings],
  );

  const hasEnough = points.length >= 2;

  useEffect(() => {
    if (!containerRef.current || !hasEnough) return;

    let cancelled = false;
    const tempUnit = useFahrenheit ? "°F" : "°C";

    const temps = points.map((r) => (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature));
    const hums = points.map((r) => r.humidity);
    const times = points.map((r) => r.timestampMs as number);

    const tempMin = Math.min(...temps) - 1;
    const tempMax = Math.max(...temps) + 1;
    const humMin = Math.max(0, Math.min(...hums) - 5);
    const humMax = Math.min(100, Math.max(...hums) + 5);

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
          showscale: true,
          colorbar: {
            title: { text: "Time", font: { color: "#607080" } },
            tickfont: { color: "#607080" },
            tickmode: "array",
            tickvals: [times[0], times[times.length - 1]],
            ticktext: [
              zonedDateString(times[0], timezone).slice(0, 16),
              zonedDateString(times[times.length - 1], timezone).slice(0, 16),
            ],
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
      height: 460,
      uirevision: `${useFahrenheit ? "f" : "c"}|${timezone}|${viewKey}`,
      margin: { l: 56, r: 24, t: 16, b: 48 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, ui-sans-serif, system-ui, sans-serif", size: 12, color: "#607080" },
      hovermode: "closest",
      hoverlabel: { bgcolor: "#ffffff", bordercolor: "#d8e0e6", font: { color: "#182027" } },
      xaxis: {
        title: { text: "Humidity (%)", font: { color: "#087ea4" } },
        range: [humMin, humMax],
        gridcolor: "#eef2f4",
        linecolor: "#b8c3cc",
        tickcolor: "#b8c3cc",
        zeroline: false,
      },
      yaxis: {
        title: { text: `Temperature (${tempUnit})`, font: { color: "#c2410c" } },
        range: [tempMin, tempMax],
        gridcolor: "#eef2f4",
        linecolor: "#b8c3cc",
        tickcolor: "#b8c3cc",
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
  }, [points, hasEnough, useFahrenheit, timezone, viewKey]);

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
          viewKey={`${rangeHours ?? "all"}|${device}`}
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
          viewKey={`${rangeHours ?? "all"}|${device}`}
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
          viewKey={`${rangeHours ?? "all"}|${device}`}
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
