import { formatNumber } from "@/lib/format";
import { absoluteHumidity, dewPointCelsius, heatIndexCelsius } from "@/lib/psychrometrics";
import type { Trend } from "@/lib/trends";
import { toFahrenheit, toFahrenheitDelta } from "@/lib/units";
import { TrendArrow } from "./TrendArrow";

export function StatusCard({
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
