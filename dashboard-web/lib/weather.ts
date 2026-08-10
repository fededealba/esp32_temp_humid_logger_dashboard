import { getSupabaseConfig } from "./db";

export type OfficialWeather = {
  temperature: number;
  humidity: number;
  observedAt: string;
};

type OfficialWeatherRow = {
  temperature: number;
  humidity: number;
  observed_at: string;
};

type OpenMeteoCurrentResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
  };
};

// Open-Meteo's free forecast API; no API key required at this call volume
// (the route's own Cache-Control keeps this well under the 10,000/day
// non-commercial limit).
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

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

// History logged by scripts/log-weather.mjs (one row every ~30 min), read
// back for the temperature chart overlay. Unlike lib/db.ts's readings, this
// table grows slowly enough (~48 rows/day) that it doesn't need stride
// downsampling -- ordering newest-first with a generous cap, then
// re-sorting ascending, is enough to guarantee recent data is never
// truncated even if the table eventually grows past the cap.
const HISTORY_ROW_CAP = 5000;

export async function loadOfficialWeatherHistory(rangeHours: number | null): Promise<OfficialWeather[]> {
  const config = getSupabaseConfig();
  if (!config) return [];

  const params = new URLSearchParams({
    select: "temperature,humidity,observed_at",
    order: "observed_at.desc",
    limit: String(HISTORY_ROW_CAP),
  });
  if (rangeHours !== null && rangeHours > 0) {
    const cutoffIso = new Date(Date.now() - rangeHours * 3_600_000).toISOString();
    params.append("observed_at", `gte.${cutoffIso}`);
  }

  const res = await fetch(`${config.url}/rest/v1/official_weather?${params}`, {
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const rows = (await res.json()) as OfficialWeatherRow[];
  return rows
    .map((row) => ({ temperature: row.temperature, humidity: row.humidity, observedAt: row.observed_at }))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}
