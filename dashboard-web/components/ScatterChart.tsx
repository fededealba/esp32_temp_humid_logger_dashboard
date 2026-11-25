import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Config, Data, Layout } from "plotly.js";
import type { Reading } from "@/lib/types";
import { ratePerMinute } from "@/lib/trends";
import { toFahrenheit } from "@/lib/units";
import { zonedDateString, zonedDateStringMs } from "@/lib/zoned-time";
import { loadPlotly, purgePlot } from "./plotly";
import { useDarkMode } from "./useDarkMode";
import { NARROW_QUERY, TOUCH_QUERY, useMediaQuery } from "./useMediaQuery";

export function ScatterRate({
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

export function ScatterChart({
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
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const isTouch = useMediaQuery(TOUCH_QUERY);
  const [animFrame, setAnimFrame] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

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
        hovertemplate: `%{x:.1f}% RH, %{y:.1f}${tempUnit}<br>%{customdata}<extra></extra>`,
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
      // On touch screens a drag must scroll the page, not zoom the chart.
      dragmode: isTouch ? false : "zoom",
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
      // No "Double-click to zoom back out" popup: on phones the page's
      // Reset zoom button is the way back, and on desktop it's noise.
      showTips: false,
      scrollZoom: false,
      displayModeBar: isTouch ? false : "hover",
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
    };

    loadPlotly().then((Plotly) => {
      if (cancelled || !containerRef.current) return;
      Plotly.react(containerRef.current, data, layout, config);
    });

    return () => {
      cancelled = true;
    };
  }, [displayPoints, points, hasEnough, isDark, useFahrenheit, timezone, viewKey, isNarrow, isTouch]);

  useEffect(() => {
    const element = containerRef.current;
    return () => {
      if (element) purgePlot(element);
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
        className="chart-host scatter"
        style={{ display: hasEnough ? "block" : "none" }}
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
          <ScatterRate label="Temp" value={tempRate} unit={`${tempUnit}/min`} colorClass="rate-temp" />
          <ScatterRate label="Humidity" value={humRate} unit="%/min" colorClass="rate-humidity" />
        </div>
        </>
      ) : null}
    </div>
  );
}
