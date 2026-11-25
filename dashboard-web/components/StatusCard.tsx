import { formatNumber } from "@/lib/format";
import { absoluteHumidity, dewPointCelsius, heatIndexCelsius } from "@/lib/psychrometrics";
import type { Trend } from "@/lib/trends";
import { toFahrenheit, toFahrenheitDelta } from "@/lib/units";
import { TrendArrow } from "./TrendArrow";

// Only mention "feels like" when it actually differs from the air
// temperature; below ~27°C the heat index equals it, which is most of the
// year, and repeating the same number as a headline value was just noise.
const FEELS_LIKE_MIN_DIFF_C = 0.5;

const signed = (n: number, unit: string) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatNumber(Math.abs(n))}${unit}`;

export function StatusCard({
  title = null,
  titleHint,
  currentTempC,
  humidity,
  useFahrenheit,
  tempTrend = null,
  humidityTrend = null,
  official = null,
}: {
  /** Device name shown in the card's header (multi-device view). */
  title?: string | null;
  /** Tooltip for the title, e.g. the full device ID. */
  titleHint?: string;
  currentTempC: number | null;
  humidity: number | null;
  useFahrenheit: boolean;
  tempTrend?: Trend;
  humidityTrend?: Trend;
  /** Open-Meteo outdoor reading, for the "vs outdoor" deltas. */
  official?: { temperature: number; humidity: number } | null;
}) {
  const unit = useFahrenheit ? "°F" : "°C";
  const show = (celsius: number) => (useFahrenheit ? toFahrenheit(celsius) : celsius);
  const haveBoth = currentTempC !== null && humidity !== null;

  const heatC = haveBoth ? heatIndexCelsius(currentTempC, humidity) : null;
  const feelsLikeC =
    heatC !== null && currentTempC !== null && Math.abs(heatC - currentTempC) >= FEELS_LIKE_MIN_DIFF_C ? heatC : null;
  const dewPointC = haveBoth ? dewPointCelsius(currentTempC, humidity) : null;
  const absHumidity = haveBoth ? absoluteHumidity(currentTempC, humidity) : null;

  // Delta is computed in Celsius first, then scaled — converting each side
  // to °F independently and subtracting would double-apply the +32 offset.
  const outdoorDeltaC = currentTempC !== null && official ? currentTempC - official.temperature : null;
  const outdoorDeltaHumidity = humidity !== null && official ? humidity - official.humidity : null;

  // Clamp the marker so it sits inside the gauge for any input.
  const markerPct = humidity === null ? null : Math.max(0, Math.min(100, humidity));

  return (
    <section className="status-card">
      {title ? (
        <h2 className="status-card-title" title={titleHint}>
          {title}
        </h2>
      ) : null}
      <div className="status-metrics">
        <div className="status-metric temp">
          <div className="status-value">
            {currentTempC === null ? "--" : `${formatNumber(show(currentTempC))}${unit}`}
            <TrendArrow trend={tempTrend} />
          </div>
          <div className="status-label">Temperature</div>
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
        {feelsLikeC !== null ? (
          <span className="feels-like">
            <span className="extra-metric-label">Feels like</span> {formatNumber(show(feelsLikeC))}
            {unit}
          </span>
        ) : null}
        <span>
          <span className="extra-metric-label">Dew point</span>{" "}
          {dewPointC === null ? "--" : `${formatNumber(show(dewPointC))}${unit}`}
        </span>
        <span>
          <span className="extra-metric-label">Abs. humidity</span>{" "}
          {absHumidity === null ? "--" : `${formatNumber(absHumidity)} g/m³`}
        </span>
        {outdoorDeltaC !== null && outdoorDeltaHumidity !== null ? (
          <span title="This sensor minus the official outdoor reading">
            <span className="extra-metric-label">vs outdoor</span>{" "}
            {signed(useFahrenheit ? toFahrenheitDelta(outdoorDeltaC) : outdoorDeltaC, unit)} ·{" "}
            {signed(outdoorDeltaHumidity, "%")}
          </span>
        ) : null}
      </div>
    </section>
  );
}
