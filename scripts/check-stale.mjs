// Checks whether the ESP32 has stopped reporting, and messages Telegram on
// the transition into/out of that state (not on every run, so an extended
// outage doesn't spam repeated alerts).
//
// Usage: node scripts/check-stale.mjs
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

// Matches STALE_AFTER_MS in dashboard-web/app/page.tsx (5x the ~60s post interval).
const STALE_AFTER_MS = 5 * 60 * 1000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function supabaseFetch(url, key, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function sendTelegramMessage(botToken, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv("TELEGRAM_CHAT_ID");

  const latestRows = await supabaseFetch(
    `${supabaseUrl}/rest/v1/readings?select=device_ts,received_at&order=received_at.desc&limit=1`,
    supabaseKey,
  );

  const [state] = await supabaseFetch(
    `${supabaseUrl}/rest/v1/alert_state?select=is_stale&id=eq.1`,
    supabaseKey,
  );
  const wasStale = state?.is_stale ?? false;

  let isStale;
  let ageMinutes = null;
  if (latestRows.length === 0) {
    isStale = true;
  } else {
    const { device_ts, received_at } = latestRows[0];
    const deviceTsMs = device_ts ? Date.parse(device_ts) : NaN;
    const timestampMs = Number.isFinite(deviceTsMs) ? deviceTsMs : Date.parse(received_at);
    ageMinutes = Math.round((Date.now() - timestampMs) / 60_000);
    isStale = Date.now() - timestampMs > STALE_AFTER_MS;
  }

  console.log(`isStale=${isStale} wasStale=${wasStale} ageMinutes=${ageMinutes}`);

  if (isStale && !wasStale) {
    const message = latestRows.length === 0
      ? "🔴 ESP32 weather station: no readings found at all."
      : `🔴 ESP32 weather station has gone quiet — last reading was ${ageMinutes} minutes ago.`;
    await sendTelegramMessage(botToken, chatId, message);
  } else if (!isStale && wasStale) {
    await sendTelegramMessage(botToken, chatId, "🟢 ESP32 weather station is back online.");
  }

  if (isStale !== wasStale) {
    await supabaseFetch(`${supabaseUrl}/rest/v1/alert_state?id=eq.1`, supabaseKey, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        is_stale: isStale,
        last_alert_at: new Date().toISOString(),
      }),
    });
  }
}

main().catch((error) => {
  console.error("check-stale failed:", error.message);
  process.exit(1);
});
