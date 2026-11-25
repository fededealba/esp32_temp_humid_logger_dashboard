"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MetricChart } from "@/components/MetricChart";
import { ScatterChart } from "@/components/ScatterChart";
import { StatusCard } from "@/components/StatusCard";
import { loadCached, saveCached } from "@/lib/cache";
import { STALE_AFTER_MS } from "@/lib/constants";
import { deviceLabel } from "@/lib/devices";
import { formatAge, formatAgo, formatNumber, formatShortTime, formatTime } from "@/lib/format";
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
const REFRESH_INTERVAL_MS = 30_000;
const WEATHER_REFRESH_INTERVAL_MS = 5 * 60_000;

type Prefs = {
  rangeHours: number | null;
  device: string;
  useFahrenheit: boolean;
  timezone: string;
  autoRefresh: boolean;
};
type WeatherPoint = { timestampMs: number; temperature: number; humidity: number };

const DEFAULT_PREFS: Prefs = {
  rangeHours: 24,
  device: "all",
  useFahrenheit: false,
  timezone: process.env.NEXT_PUBLIC_DASHBOARD_TIMEZONE || "Europe/Paris",
  autoRefresh: true,
};

const rangeParamOf = (rangeHours: number | null) => (rangeHours === null ? "all" : String(rangeHours));

export default function Page() {
  const [data, setData] = useState<ApiResponse | null>(null);
  // True while `data` is the copy saved on a previous visit and the fresh
  // request hasn't landed yet. Offline/staleness warnings are held back
  // meanwhile: they'd be judging old numbers against the current time.
  const [showingCached, setShowingCached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sharedXRange, setSharedXRange] = useState<[string, string] | null>(null);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [weatherHistory, setWeatherHistory] = useState<WeatherPoint[]>([]);
  // "Now" for age labels, ticked by refreshes and a timer rather than read
  // during render, so "3 min ago" keeps moving even with auto-refresh off.
  const [now, setNow] = useState(() => Date.now());

  const { rangeHours, device, useFahrenheit, timezone, autoRefresh } = prefs;
  const updatePrefs = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), []);

  // Restore the settings from the last visit before the first fetch, so the
  // phone reopens on the range/device you left it on (and doesn't fetch the
  // default range first).
  useEffect(() => {
    const saved = loadCached<Partial<Prefs>>("prefs");
    if (saved) setPrefs((p) => ({ ...p, ...saved.value }));
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (prefsLoaded) saveCached("prefs", prefs);
  }, [prefs, prefsLoaded]);

  // Touch screens: drags scroll the page, so zooming is an explicit mode
  // that ends by itself after one zoom, giving scrolling back.
  const [touchZoom, setTouchZoom] = useState(false);

  const handleXRangeChange = useCallback((range: [string, string] | null) => {
    setSharedXRange(range);
    if (range) setTouchZoom(false);
  }, []);

  const viewKey = `${rangeHours ?? "all"}|${device}`;

  // Reset the shared zoom whenever the data window or timezone changes.
  useEffect(() => {
    setSharedXRange(null);
  }, [viewKey, timezone]);

  // Monotonic request ids: only the most recently started request may update
  // state. Without this, switching from a slow range ("All") to a fast one
  // ("1h") lets the slow response land last and overwrite the chart with
  // data for a range the selector no longer shows.
  const readingsRequestId = useRef(0);
  const weatherRequestId = useRef(0);

  // Show the readings saved on the last visit immediately: after the server
  // has gone idle, the first fresh response can take several seconds, which
  // is exactly when a phone opens the page. Only one range is kept, so
  // switching ranges never shows another range's data under the wrong label.
  useEffect(() => {
    if (!prefsLoaded) return;
    const cached = loadCached<{ range: string; payload: ApiResponse }>("readings");
    if (cached && cached.value.range === rangeParamOf(rangeHours) && cached.value.payload.ok) {
      setData(cached.value.payload);
      setShowingCached(true);
    }
    const cachedWeather = loadCached<{ current: WeatherResponse; history: WeatherPoint[]; range: string }>("weather");
    if (cachedWeather) {
      setWeather(cachedWeather.value.current);
      if (cachedWeather.value.range === rangeParamOf(rangeHours)) setWeatherHistory(cachedWeather.value.history);
    }
  }, [prefsLoaded, rangeHours]);

  // The server windows + downsamples based on `range_hours`, so the payload
  // size scales with the selected range instead of always being 5000 rows.
  const refresh = useCallback(async () => {
    const requestId = ++readingsRequestId.current;
    const isCurrent = () => requestId === readingsRequestId.current;
    setLoading(true);
    try {
      const rangeParam = rangeParamOf(rangeHours);
      const response = await fetch(`/api/readings?range_hours=${rangeParam}`, { cache: "no-store" });
      const payload = (await response.json()) as ApiResponse;
      if (!isCurrent()) return;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "Could not load readings" : payload.error);
      }
      setData(payload);
      setShowingCached(false);
      setError(null);
      saveCached("readings", { range: rangeParam, payload });
    } catch (caught) {
      if (!isCurrent()) return;
      // Keep whatever is on screen (fresh or saved) and say it's not current.
      setError(caught instanceof Error ? caught.message : "Could not load readings");
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setNow(Date.now());
      }
    }
  }, [rangeHours]);

  // Separate from the readings poll: the API route caches Open-Meteo
  // responses for several minutes, so polling every 30s like the readings
  // endpoint would just re-request the same cached value. A failure here is
  // non-critical (the comparison simply disappears), so it's swallowed
  // rather than surfaced through the same `error` banner as readings.
  const refreshWeather = useCallback(async () => {
    const requestId = ++weatherRequestId.current;
    try {
      const rangeParam = rangeParamOf(rangeHours);
      const [current, history] = await Promise.all([
        fetch("/api/weather", { cache: "no-store" }).then((r) => r.json() as Promise<WeatherResponse>),
        fetch(`/api/weather/history?range_hours=${rangeParam}`, { cache: "no-store" }).then(
          (r) => r.json() as Promise<WeatherHistoryResponse>,
        ),
      ]);
      if (requestId !== weatherRequestId.current) return;
      setWeather(current);
      const points = history.ok
        ? history.points
            .map((p) => ({ timestampMs: Date.parse(p.observedAt), temperature: p.temperature, humidity: p.humidity }))
            .filter((p) => Number.isFinite(p.timestampMs))
        : null;
      if (points) setWeatherHistory(points);
      if (current.ok) saveCached("weather", { current, history: points ?? [], range: rangeParam });
    } catch {
      // Keep whatever was last loaded.
    }
  }, [rangeHours]);

  useEffect(() => {
    if (!prefsLoaded) return;
    refresh();
  }, [refresh, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) return;
    refreshWeather();
    const interval = window.setInterval(refreshWeather, WEATHER_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshWeather, prefsLoaded]);

  // Background tabs (and every app you switch away from on a phone) have
  // their timers paused, so coming back would show old numbers until the
  // next tick. Refresh the moment the page is visible again instead, and
  // only poll while it's visible.
  useEffect(() => {
    if (!prefsLoaded) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      refresh();
      refreshWeather();
    };
    // pageshow covers iOS restoring the page from its back/forward cache.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onVisible();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [refresh, refreshWeather, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) return;
    const interval = window.setInterval(() => {
      setNow(Date.now());
      if (autoRefresh && document.visibilityState === "visible") refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh, prefsLoaded]);

  const official = weather?.ok && weather.configured ? weather : null;

  const readings = useMemo(() => (data?.ok ? data.readings : []), [data]);
  const latestOverall = data?.ok ? data.latest : null;
  // Devices seen in the selected range, plus the newest device overall and
  // the currently selected one: a device that went quiet before the range
  // started must stay selectable, or the selector would silently show
  // "All" while still filtering to it.
  const devices = useMemo(() => {
    const ids = new Set(readings.map((reading) => reading.deviceId));
    if (latestOverall) ids.add(latestOverall.deviceId);
    if (device !== "all") ids.add(device);
    return Array.from(ids).sort();
  }, [readings, latestOverall, device]);

  // The server already windows to `rangeHours`; here we only narrow by device.
  const filtered = useMemo(() => {
    if (device === "all") return readings;
    return readings.filter((reading) => reading.deviceId === device);
  }, [device, readings]);

  const latest = filtered[0];
  const tempUnit = useFahrenheit ? "F" : "C";
  const singleDeviceView = device !== "all" || devices.length <= 1;

  // One card per device when viewing "All" with more than one present,
  // instead of a single ambiguous "latest reading from whichever device
  // happened to post most recently" value.
  const latestByDevice = useMemo(() => {
    const map = new Map<string, Reading>();
    for (const reading of filtered) {
      if (!map.has(reading.deviceId)) map.set(reading.deviceId, reading);
    }
    return map;
  }, [filtered]);

  // Per-device trend (last 10 min), independent of the device filter above.
  const trendByDevice = useMemo(() => {
    const cutoff = now - TREND_WINDOW_MS;
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
  }, [readings, now]);

  // Max/Min for each chart header, in the displayed unit.
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
  const lastAgeMs = lastArrivalMs !== null ? Math.max(0, now - lastArrivalMs) : null;
  const isStale = !showingCached && lastAgeMs !== null && lastAgeMs > STALE_AFTER_MS;
  // A specific device with nothing in range and no known newest reading
  // (it isn't the most recent device overall, e.g. a second sensor that died
  // while the other kept posting): we can't say how long ago, but it's quiet.
  const deviceMissingFromRange =
    !showingCached && data?.ok === true && device !== "all" && filtered.length === 0 && newestForDevice === null;

  // Only warn on a known-old heartbeat; null means "unknown" (schema
  // predating the column), not "broken".
  const alertsCheckedMs = data?.ok && data.alertsCheckedAt ? Date.parse(data.alertsCheckedAt) : NaN;
  const alertsStale =
    !showingCached && Number.isFinite(alertsCheckedMs) && now - alertsCheckedMs > ALERTS_STALE_AFTER_MS;

  const updating = loading || showingCached;

  return (
    <main className="page">
      <header className="topbar">
        <div className="topbar-text">
          <h1>ESP32 Weather Monitor</h1>
          <p className="status-line">
            {newestForDevice && lastAgeMs !== null ? (
              <>
                Last reading {formatTime(newestForDevice, timezone)} · {formatAgo(lastAgeMs)}
              </>
            ) : updating ? (
              "Loading…"
            ) : (
              "Waiting for readings"
            )}
            {updating && newestForDevice ? <span className="updating"> · updating…</span> : null}
          </p>
        </div>
        <button
          className="icon-button refresh-button"
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh data"
        >
          <span aria-hidden="true" className={loading ? "spin" : undefined}>
            ↻
          </span>
          <span className="refresh-text">Refresh</span>
        </button>
      </header>

      {isStale && lastAgeMs !== null && newestForDevice ? (
        <div className="warning-banner" role="status">
          ⚠ No new readings for {formatAge(lastAgeMs)}
          {device !== "all" ? ` from ${deviceLabel(device)}` : ""} — the device may be offline.
        </div>
      ) : deviceMissingFromRange ? (
        <div className="warning-banner" role="status">
          ⚠ No readings from {deviceLabel(device)} in the selected range — the device may be offline. Try a longer
          range.
        </div>
      ) : null}

      {alertsStale ? (
        <div className="warning-banner" role="status">
          ⚠ Offline alerts haven&apos;t run for {formatAge(now - alertsCheckedMs)}, so Telegram won&apos;t notify you
          if the station goes quiet. GitHub may have disabled the stale-check workflow: re-enable it from the
          repository&apos;s Actions tab.
        </div>
      ) : null}

      {error ? (
        <div className="error-banner" role="status">
          Couldn&apos;t refresh: {error}
          {data?.ok ? " Showing the last readings loaded." : ""}
        </div>
      ) : null}

      {singleDeviceView ? (
        <StatusCard
          currentTempC={latest ? latest.temperature : null}
          humidity={latest ? latest.humidity : null}
          useFahrenheit={useFahrenheit}
          tempTrend={trendByDevice.get(latest?.deviceId ?? "")?.temp}
          humidityTrend={trendByDevice.get(latest?.deviceId ?? "")?.humidity}
          official={official}
        />
      ) : (
        <div className="status-card-group">
          {devices.map((deviceId) => {
            const reading = latestByDevice.get(deviceId) ?? null;
            const trend = trendByDevice.get(deviceId);
            return (
              <StatusCard
                key={deviceId}
                title={deviceLabel(deviceId)}
                titleHint={deviceId}
                currentTempC={reading ? reading.temperature : null}
                humidity={reading ? reading.humidity : null}
                useFahrenheit={useFahrenheit}
                tempTrend={trend?.temp}
                humidityTrend={trend?.humidity}
                official={official}
              />
            );
          })}
        </div>
      )}

      {official ? (
        <p className="outdoor-line">
          <span className="extra-metric-label">Outdoor</span>{" "}
          <strong>
            {formatNumber(useFahrenheit ? toFahrenheit(official.temperature) : official.temperature)}°{tempUnit} ·{" "}
            {formatNumber(official.humidity)}%
          </strong>{" "}
          <span className="extra-metric-label">
            Open-Meteo, {formatShortTime(Date.parse(official.observedAt), timezone, now)}
          </span>
        </p>
      ) : null}

      <section className="toolbar" aria-label="Dashboard controls">
        <div className="chip-row ranges" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range.label}
              type="button"
              className="chip"
              aria-pressed={rangeHours === range.hours}
              onClick={() => updatePrefs({ rangeHours: range.hours })}
            >
              {range.label}
            </button>
          ))}
        </div>
        {devices.length > 1 ? (
          <div className="chip-row" role="group" aria-label="Device">
            {["all", ...devices].map((deviceId) => (
              <button
                key={deviceId}
                type="button"
                className="chip"
                title={deviceId === "all" ? undefined : deviceId}
                aria-pressed={device === deviceId}
                onClick={() => updatePrefs({ device: deviceId })}
              >
                {deviceId === "all" ? (devices.length === 2 ? "Both" : "All sensors") : deviceLabel(deviceId)}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="settings-toggle"
          aria-expanded={settingsOpen}
          aria-controls="settings-panel"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          Settings {settingsOpen ? "▴" : "▾"}
        </button>
        <div id="settings-panel" className={`settings-panel${settingsOpen ? " open" : ""}`}>
          <label className="select-label">
            Timezone
            <select value={timezone} onChange={(event) => updatePrefs({ timezone: event.target.value })}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={useFahrenheit}
              onChange={(event) => updatePrefs({ useFahrenheit: event.target.checked })}
            />
            Fahrenheit
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => updatePrefs({ autoRefresh: event.target.checked })}
            />
            Auto-refresh
          </label>
        </div>
      </section>

      {/* Touch screens only (hidden with a fine pointer in globals.css). */}
      <div className="zoom-bar">
        <button
          type="button"
          className="chip"
          aria-pressed={touchZoom}
          onClick={() => setTouchZoom((on) => !on)}
        >
          {touchZoom ? "Cancel zoom" : "🔍 Zoom"}
        </button>
        {touchZoom ? (
          <span className="zoom-hint">Drag sideways across a chart to pick a time span</span>
        ) : sharedXRange ? (
          <button type="button" className="chip" onClick={() => setSharedXRange(null)}>
            Reset zoom
          </button>
        ) : null}
      </div>

      <section className={`panel chart-panel${touchZoom ? " zooming" : ""}`}>
        <div className="panel-header">
          <h2>Temperature (°{tempUnit})</h2>
          <span>
            {tempStats
              ? `Max ${formatNumber(tempStats.max)}° · Min ${formatNumber(tempStats.min)}°`
              : updating
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
          touchZoom={touchZoom}
        />
      </section>

      <section className={`panel chart-panel${touchZoom ? " zooming" : ""}`}>
        <div className="panel-header">
          <h2>Humidity (%)</h2>
          <span>
            {humStats
              ? `Max ${formatNumber(humStats.max)}% · Min ${formatNumber(humStats.min)}%`
              : updating
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
          touchZoom={touchZoom}
        />
      </section>

      {/* One chronological path per chart, so it only makes sense for a single
          device; with several, pick one with the device buttons above. */}
      {singleDeviceView ? (
        <section className="panel chart-panel">
          <div className="panel-header">
            <h2>Temperature vs Humidity</h2>
            <span>{updating && !filtered.length ? "Loading" : `${filtered.length} points`}</span>
          </div>
          <ScatterChart
            readings={filtered}
            useFahrenheit={useFahrenheit}
            timezone={timezone}
            viewKey={viewKey}
            xAxisRange={sharedXRange}
          />
        </section>
      ) : null}

      <section className="panel table-panel">
        <div className="panel-header">
          <h2>Recent Readings</h2>
          {/* Charts and table are downsampled server-side on long ranges. */}
          <span>{data?.ok && data.stride > 1 ? `1 in ${data.stride} shown` : ""}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                {singleDeviceView ? null : <th>Device</th>}
                <th className="num">Temp</th>
                <th className="num">Humidity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 12).map((reading) => (
                <tr key={reading.id}>
                  <td>{formatTime(reading, timezone)}</td>
                  {singleDeviceView ? null : <td title={reading.deviceId}>{deviceLabel(reading.deviceId)}</td>}
                  <td className="num">
                    {formatNumber(useFahrenheit ? toFahrenheit(reading.temperature) : reading.temperature)}°{tempUnit}
                  </td>
                  <td className="num">{formatNumber(reading.humidity)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && !updating ? (
            <div className="empty-panel">No readings match the selected filters.</div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
