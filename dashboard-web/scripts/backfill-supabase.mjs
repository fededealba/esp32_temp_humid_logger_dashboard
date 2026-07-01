// One-off migration: copy historical readings from the Google Sheet into
// Supabase's `readings` table. Only rows strictly older than the earliest
// timestamp already present in Supabase are inserted, so it's safe to
// re-run — a repeat run naturally has nothing left to backfill.
//
// Usage (from dashboard-web/):
//   node --env-file=.env.local scripts/backfill-supabase.mjs
//
// Requires the same env vars as the dashboard: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, and Google credentials (GOOGLE_CREDENTIALS_JSON,
// or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY, or dashboard/credentials.json
// relative to the repo root).

import fs from "node:fs/promises";
import path from "node:path";
import { JWT } from "google-auth-library";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const DEFAULT_SHEETS_ID = "1PWeQyc0tR10fEe9v0JoBriOJLLUz-M5jYO3oxx_Z2gI";
const BATCH_SIZE = 500;

function fixPrivateKey(privateKey) {
  return privateKey.replace(/\\n/g, "\n");
}

async function loadLocalCredentials() {
  const candidates = process.env.GOOGLE_CREDENTIALS_FILE
    ? [process.env.GOOGLE_CREDENTIALS_FILE]
    : [
        path.join(process.cwd(), "dashboard", "credentials.json"),
        path.join(process.cwd(), "..", "dashboard", "credentials.json"),
      ];

  for (const credentialPath of candidates) {
    try {
      const raw = await fs.readFile(credentialPath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`Could not read Google credentials file at ${credentialPath}`);
    }
  }
  return null;
}

async function loadCredentials() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY,
    };
  }
  const local = await loadLocalCredentials();
  if (local) return local;
  throw new Error(
    "Google credentials are not configured. Set GOOGLE_CREDENTIALS_JSON, GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY, or add dashboard/credentials.json.",
  );
}

async function getAccessToken() {
  const credentials = await loadCredentials();
  const client = new JWT({
    email: credentials.client_email,
    key: fixPrivateKey(credentials.private_key),
    scopes: [SHEETS_SCOPE],
  });
  const accessToken = await client.getAccessToken();
  if (!accessToken.token) throw new Error("Could not obtain a Google API access token.");
  return accessToken.token;
}

async function sheetsFetch(url) {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Sheets API returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

function parseNumber(value) {
  if (!value) return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseTimestampMs(value) {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function mapHeader(header, index) {
  const lower = header.toLowerCase();
  if (lower.includes("timestamp") && index === 0) return "receivedAt";
  if (lower.includes("temperature")) return "temperature";
  if (lower.includes("humidity")) return "humidity";
  if (lower.includes("device")) return "deviceId";
  if (lower.includes("timestamp") && index > 0) return "deviceTimestamp";
  return null;
}

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header) => {
    const clean = header.trim() || "Column";
    const count = seen.get(clean) ?? 0;
    seen.set(clean, count + 1);
    return count === 0 ? clean : `${clean}_${count}`;
  });
}

function normalizeRows(values) {
  if (values.length < 2) return [];
  const headers = uniqueHeaders(values[0]);
  const mappings = headers.map(mapHeader);

  return values.slice(1).flatMap((row) => {
    const record = {};
    row.forEach((value, cellIndex) => {
      const key = mappings[cellIndex];
      if (key) record[key] = value;
    });

    const temperature = parseNumber(record.temperature);
    const humidity = parseNumber(record.humidity);
    if (temperature === null || humidity === null) return [];

    const deviceTsMs = parseTimestampMs(record.deviceTimestamp);
    const receivedAtMs = parseTimestampMs(record.receivedAt);
    const timestampMs = deviceTsMs ?? receivedAtMs;
    if (timestampMs === null) return []; // can't safely order/dedupe without a timestamp

    return [{
      deviceId: record.deviceId || "unknown",
      temperature,
      humidity,
      deviceTsIso: deviceTsMs ? new Date(deviceTsMs).toISOString() : null,
      receivedAtIso: receivedAtMs ? new Date(receivedAtMs).toISOString() : new Date(timestampMs).toISOString(),
      timestampMs,
    }];
  });
}

async function fetchSheetReadings() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID || DEFAULT_SHEETS_ID;
  const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(title))`;
  const metadata = await sheetsFetch(metadataUrl);
  const sheetTitle = metadata.sheets?.[0]?.properties?.title;
  if (!sheetTitle) throw new Error("Could not find the first sheet in the Google spreadsheet.");

  const range = `${quoteSheetName(sheetTitle)}!A:Z`;
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const sheetValues = await sheetsFetch(valuesUrl);
  return normalizeRows(sheetValues.values ?? []);
}

async function getSupabaseCutoffMs(url, key) {
  const res = await fetch(
    `${url}/rest/v1/readings?select=received_at&order=received_at.asc&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Supabase returned ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.length > 0 ? Date.parse(rows[0].received_at) : null;
}

async function insertBatch(url, key, batch) {
  const res = await fetch(`${url}/rest/v1/readings`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(batch),
  });
  if (!res.ok) {
    throw new Error(`Supabase insert failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  }

  console.log("Fetching Google Sheet history...");
  const readings = await fetchSheetReadings();
  console.log(`  ${readings.length} valid rows in the sheet.`);

  const cutoffMs = await getSupabaseCutoffMs(supabaseUrl, supabaseKey);
  console.log(
    cutoffMs
      ? `Supabase already has data from ${new Date(cutoffMs).toISOString()} onward; backfilling only older rows.`
      : "Supabase table is empty; backfilling everything.",
  );

  const toInsert = readings
    .filter((r) => cutoffMs === null || r.timestampMs < cutoffMs)
    .map((r) => ({
      device_id: r.deviceId,
      temperature: r.temperature,
      humidity: r.humidity,
      device_ts: r.deviceTsIso,
      received_at: r.receivedAtIso,
    }));

  console.log(`Inserting ${toInsert.length} rows in batches of ${BATCH_SIZE}...`);
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    await insertBatch(supabaseUrl, supabaseKey, batch);
    console.log(`  inserted ${Math.min(i + BATCH_SIZE, toInsert.length)} / ${toInsert.length}`);
  }

  console.log("Backfill complete.");
}

main().catch((error) => {
  console.error("Backfill failed:", error.message);
  process.exit(1);
});
