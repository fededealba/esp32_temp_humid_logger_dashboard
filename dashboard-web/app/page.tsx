"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MetricChart } from "@/components/MetricChart";
import { ScatterChart } from "@/components/ScatterChart";
import { StatusCard } from "@/components/StatusCard";
import { STALE_AFTER_MS } from "@/lib/constants";
import { formatAge, formatNumber, formatTime } from "@/lib/format";
import { arrivalMs, newestByArrival } from "@/lib/freshness";
import { TREND_WINDOW_MS, deviceTrends, type Trend } from "@/lib/trends";
import type { ApiResponse, Reading, WeatherHistoryResponse, WeatherResponse } from "@/lib/types";
import { toFahrenheit } from "@/lib/units";

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

// The stale-check is scheduled every 5 min, but GitHub's scheduler has been
// observed skipping up to ~2h under load; 6h of silence means it's stopped
// (e.g. GitHub auto-disabled it after 60 days without commits).
const ALERTS_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

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

  // Monotonic request ids: only the most recently started request may update
  // state. Without this, switching from a slow range ("All") to a fast one
  // ("1h") lets the slow response land last and overwrite the chart with
  // data for a range the dropdown no longer shows.
  const readingsRequestId = useRef(0);
  const weatherRequestId = useRef(0);

  // The server windows + downsamples based on `range_hours`, so the payload
  // size scales with the selected range instead of always being 5000 rows.
  const refresh = useCallback(async () => {
    const requestId = ++readingsRequestId.current;
    const isCurrent = () => requestId === readingsRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const rangeParam = rangeHours === null ? "all" : String(rangeHours);
      const response = await fetch(`/api/readings?range_hours=${rangeParam}`, { cache: "no-store" });
      const payload = (await response.json()) as ApiResponse;
      if (!isCurrent()) return;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "Could not load readings" : payload.error);
      }
      setData(payload);
    } catch (caught) {
      if (!isCurrent()) return;
      setError(caught instanceof Error ? caught.message : "Could not load readings");
    } finally {
      if (isCurrent()) setLoading(false);
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
    const requestId = ++weatherRequestId.current;
    try {
      const rangeParam = rangeHours === null ? "all" : String(rangeHours);
      const [current, history] = await Promise.all([
        fetch("/api/weather", { cache: "no-store" }).then((r) => r.json() as Promise<WeatherResponse>),
        fetch(`/api/weather/history?range_hours=${rangeParam}`, { cache: "no-store" }).then(
          (r) => r.json() as Promise<WeatherHistoryResponse>,
        ),
      ]);
      if (requestId !== weatherRequestId.current) return;
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
  const latestOverall = data?.ok ? data.latest : null;
  // Devices seen in the selected range, plus the newest device overall and
  // the currently selected one: a device that went quiet before the range
  // started must stay selectable, or the controlled <select> would silently
  // display "All devices" while still filtering to it.
  const devices = useMemo(() => {
    const ids = new Set(readings.map((reading) => reading.deviceId));
    if (latestOverall) ids.add(latestOverall.deviceId);
    if (device !== "all") ids.add(device);
    return Array.from(ids).sort();
  }, [readings, latestOverall, device]);

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

  // Most recently *arrived* reading for the selected device (see
  // lib/freshness: arrival time comes from the database clock, so an
  // unsynced or drifting ESP32 clock can't trigger or hide the warning).
  // `readings` is windowed by the server, so when the outage is longer than
  // the selected range it's empty; fall back to the API's unwindowed
  // `latest` so staleness is still caught.
  const newestForDevice = useMemo(() => {
    const pool = device === "all" ? readings : readings.filter((reading) => reading.deviceId === device);
    const inRange = newestByArrival(pool);
    if (inRange) return inRange;
    if (latestOverall && arrivalMs(latestOverall) !== null && (device === "all" || latestOverall.deviceId === device)) {
      return latestOverall;
    }
    return null;
  }, [device, readings, latestOverall]);
  const lastArrivalMs = newestForDevice ? arrivalMs(newestForDevice) : null;
  const lastAgeMs = lastArrivalMs !== null ? Date.now() - lastArrivalMs : null;
  const isStale = lastAgeMs !== null && lastAgeMs > STALE_AFTER_MS;
  // A specific device with nothing in range and no known newest reading
  // (it isn't the most recent device overall, e.g. a second sensor that died
  // while the other kept posting): we can't say how long ago, but it's quiet.
  const deviceMissingFromRange =
    data?.ok === true && device !== "all" && filtered.length === 0 && newestForDevice === null;

  // Only warn on a known-old heartbeat; null means "unknown" (schema
  // predating the column), not "broken".
  const alertsCheckedMs = data?.ok && data.alertsCheckedAt ? Date.parse(data.alertsCheckedAt) : NaN;
  const alertsStale = Number.isFinite(alertsCheckedMs) && Date.now() - alertsCheckedMs > ALERTS_STALE_AFTER_MS;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>ESP32 Weather Monitor</h1>
          <p>
            {newestForDevice ? `Last reading ${formatTime(newestForDevice, timezone)}` : "Waiting for readings"}
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
      ) : deviceMissingFromRange ? (
        <div className="warning-banner" role="status">
          ⚠ No readings from {device} in the selected range — the device may be offline. Try a longer range.
        </div>
      ) : null}

      {alertsStale ? (
        <div className="warning-banner" role="status">
          ⚠ Offline alerts haven&apos;t run for {formatAge(Date.now() - alertsCheckedMs)}, so Telegram won&apos;t
          notify you if the station goes quiet. GitHub may have disabled the stale-check workflow: re-enable it from
          the repository&apos;s Actions tab.
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
          {/* Charts and table are downsampled server-side on long ranges. */}
          <span>{data?.ok && data.stride > 1 ? `1 in ${data.stride} readings shown` : ""}</span>
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
