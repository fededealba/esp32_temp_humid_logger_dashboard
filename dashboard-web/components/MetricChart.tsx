import { useEffect, useMemo, useRef } from "react";
import type { Config, Data, Layout } from "plotly.js";
import type { Reading } from "@/lib/types";
import { POST_INTERVAL_MS } from "@/lib/constants";
import { withGapBreaks } from "@/lib/gaps";
import { toFahrenheit } from "@/lib/units";
import { zonedDateString } from "@/lib/zoned-time";
import { HUMIDITY_COLORS, HUMIDITY_FILL, OFFICIAL_COLOR, TEMP_COLORS, TEMP_FILL } from "./palette";
import { loadPlotly, normalizeAxisValue, purgePlot, type PlotlyEventDiv } from "./plotly";
import { useDarkMode } from "./useDarkMode";

export function MetricChart({
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
      const values = deviceReadings.map((r) =>
        isTemp ? (useFahrenheit ? toFahrenheit(r.temperature) : r.temperature) : r.humidity,
      );
      allValues.push(...values);

      const points = withGapBreaks(ts, values, POST_INTERVAL_MS);
      const x = points.map((p) => zonedDateString(p.t, timezone));
      const y = points.map((p) => p.value);
      const markerSize = points.map((p) => (p.marker ? 5 : 0));

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
      if (element) purgePlot(element);
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
