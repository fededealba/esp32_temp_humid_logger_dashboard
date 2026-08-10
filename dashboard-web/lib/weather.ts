export type OfficialWeather = {
  temperature: number;
  humidity: number;
  observedAt: string;
};

type OpenMeteoCurrentResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
  };
};

type OpenMeteoHourlyResponse = {
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
  };
};

// Open-Meteo's free forecast API; no API key required at this call volume
// (the routes' own Cache-Control keeps this well under the 10,000/day
// non-commercial limit).
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
// Confirmed empirically: requesting past_days beyond this errors with
// "Past days is invalid. Allowed range 0 to 93."
const MAX_PAST_DAYS = 92;

function getConfig(): { latitude: number; longitude: number } | null {
  const latRaw = process.env.OPEN_METEO_LATITUDE;
  const lonRaw = process.env.OPEN_METEO_LONGITUDE;
  if (!latRaw || !lonRaw) return null;
  const latitude = Number(latRaw);
  const longitude = Number(lonRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

export function isWeatherConfigured(): boolean {
  return getConfig() !== null;
}

export async function loadOfficialWeather(): Promise<OfficialWeather> {
  const config = getConfig();
  if (!config) throw new Error("Open-Meteo location is not configured.");

  // Open-Meteo's grid resolution (~1-11km depending on model) is far coarser
  // than 3-decimal-degree (~100m) precision, so rounding here loses no
  // accuracy while capping how precise a location ever leaves the server.
  const params = new URLSearchParams({
    latitude: config.latitude.toFixed(3),
    longitude: config.longitude.toFixed(3),
    current: "temperature_2m,relative_humidity_2m",
    timezone: "UTC",
  });

  const res = await fetch(`${FORECAST_URL}?${params}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Open-Meteo returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as OpenMeteoCurrentResponse;
  const temperature = body.current?.temperature_2m;
  const humidity = body.current?.relative_humidity_2m;
  const time = body.current?.time;
  if (typeof temperature !== "number" || typeof humidity !== "number" || !time) {
    throw new Error("Open-Meteo response was missing current conditions.");
  }

  // `time` is a UTC wall-clock string without an offset (e.g.
  // "2026-07-01T12:00") because of `timezone=UTC` above; append "Z" to get
  // a real ISO instant.
  const observedAt = new Date(`${time}Z`).toISOString();

  return { temperature, humidity, observedAt };
}

// History for the temperature chart overlay, fetched directly from
// Open-Meteo's hourly + past_days rather than from a self-maintained log: a
// single call returns up to 93 days of hourly history, which is both
// simpler and more reliable than polling on a schedule ever was (GitHub's
// `schedule` trigger saw 50-130 min gaps on a workflow configured for every
// 5 min -- see the comment on stale-check.yml's cron). past_days only
// accepts whole days, so short ranges still fetch a full day and get
// trimmed to the actual cutoff below.
export async function loadOfficialWeatherHistory(rangeHours: number | null): Promise<OfficialWeather[]> {
  const config = getConfig();
  if (!config) return [];

  const pastDays =
    rangeHours === null ? MAX_PAST_DAYS : Math.min(MAX_PAST_DAYS, Math.max(1, Math.ceil(rangeHours / 24)));

  const params = new URLSearchParams({
    latitude: config.latitude.toFixed(3),
    longitude: config.longitude.toFixed(3),
    hourly: "temperature_2m,relative_humidity_2m",
    past_days: String(pastDays),
    forecast_days: "1",
    timezone: "UTC",
  });

  const res = await fetch(`${FORECAST_URL}?${params}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Open-Meteo returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as OpenMeteoHourlyResponse;
  const times = body.hourly?.time ?? [];
  const temps = body.hourly?.temperature_2m ?? [];
  const hums = body.hourly?.relative_humidity_2m ?? [];

  const nowMs = Date.now();
  const cutoffMs = rangeHours !== null && rangeHours > 0 ? nowMs - rangeHours * 3_600_000 : null;

  const points: OfficialWeather[] = [];
  for (let i = 0; i < times.length; i++) {
    const temperature = temps[i];
    const humidity = hums[i];
    if (typeof temperature !== "number" || typeof humidity !== "number") continue;
    const ms = Date.parse(`${times[i]}Z`);
    if (!Number.isFinite(ms)) continue;
    if (ms > nowMs) continue; // forecast_days=1 buffer can include future hours
    if (cutoffMs !== null && ms < cutoffMs) continue;
    points.push({ temperature, humidity, observedAt: new Date(ms).toISOString() });
  }
  return points;
}
