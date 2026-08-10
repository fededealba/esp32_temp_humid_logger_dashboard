// Polls Open-Meteo for the configured location's current conditions and
// logs one row to Supabase, building a history to chart against the ESP32's
// own readings over time. Open-Meteo's own data only updates every 15-60
// min, so this doesn't need to run as often as check-stale.mjs; the
// official_weather.observed_at unique constraint makes re-polling before it
// has advanced a harmless no-op rather than a duplicate row.
//
// Mirrors the fetch logic in dashboard-web/lib/weather.ts -- kept separate
// (rather than imported) because this runs as a plain Node script outside
// the Next.js app, same as check-stale.mjs does for its own constants.
//
// Usage: node scripts/log-weather.mjs
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                     OPEN_METEO_LATITUDE, OPEN_METEO_LONGITUDE

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function fetchOfficialWeather(latitude, longitude) {
  const params = new URLSearchParams({
    // Rounded the same way as lib/weather.ts: Open-Meteo's model grid is
    // far coarser than 3-decimal-degree (~100m) precision.
    latitude: Number(latitude).toFixed(3),
    longitude: Number(longitude).toFixed(3),
    current: "temperature_2m,relative_humidity_2m",
    timezone: "UTC",
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) {
    throw new Error(`Open-Meteo returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = await res.json();
  const temperature = body.current?.temperature_2m;
  const humidity = body.current?.relative_humidity_2m;
  const time = body.current?.time;
  if (typeof temperature !== "number" || typeof humidity !== "number" || !time) {
    throw new Error("Open-Meteo response was missing current conditions.");
  }

  return { temperature, humidity, observedAt: new Date(`${time}Z`).toISOString() };
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const latitude = requireEnv("OPEN_METEO_LATITUDE");
  const longitude = requireEnv("OPEN_METEO_LONGITUDE");

  const weather = await fetchOfficialWeather(latitude, longitude);

  const res = await fetch(`${supabaseUrl}/rest/v1/official_weather?on_conflict=observed_at`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      temperature: weather.temperature,
      humidity: weather.humidity,
      observed_at: weather.observedAt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Supabase insert failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  console.log(
    `Logged official weather: ${weather.temperature}°C, ${weather.humidity}% at ${weather.observedAt}`,
  );
}

main().catch((error) => {
  console.error("log-weather failed:", error.message);
  process.exit(1);
});
