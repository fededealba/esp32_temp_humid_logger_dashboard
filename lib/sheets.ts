import fs from "node:fs/promises";
import path from "node:path";
import { JWT } from "google-auth-library";

export type Reading = {
  id: number;
  sheetRow: number;
  temperature: number;
  humidity: number;
  deviceId: string;
  receivedAt: string | null;
  deviceTimestamp: string | null;
  timestamp: string | null;
  timestampMs: number | null;
};

export type ReadingsResponse = {
  ok: true;
  generatedAt: string;
  sheetTitle: string;
  rowsLoaded: number;
  readings: Reading[];
};

type ServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
};

type SheetValuesResponse = {
  values?: string[][];
};

type SpreadsheetMetadataResponse = {
  sheets?: Array<{
    properties?: {
      title?: string;
    };
  }>;
};

const DEFAULT_SHEETS_ID = "1PWeQyc0tR10fEe9v0JoBriOJLLUz-M5jYO3oxx_Z2gI";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

function getSpreadsheetId() {
  return process.env.GOOGLE_SHEETS_ID || DEFAULT_SHEETS_ID;
}

function fixPrivateKey(privateKey: string) {
  return privateKey.replace(/\\n/g, "\n");
}

async function loadLocalCredentials(): Promise<ServiceAccountCredentials | null> {
  const credentialPath =
    process.env.GOOGLE_CREDENTIALS_FILE ||
    path.join(process.cwd(), "dashboard", "credentials.json");

  try {
    const raw = await fs.readFile(credentialPath, "utf8");
    return JSON.parse(raw) as ServiceAccountCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not read Google credentials file at ${credentialPath}`);
  }
}

async function loadCredentials() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) as ServiceAccountCredentials;
    } catch {
      throw new Error("GOOGLE_CREDENTIALS_JSON is not valid JSON.");
    }
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY,
    };
  }

  const localCredentials = await loadLocalCredentials();
  if (localCredentials) {
    return localCredentials;
  }

  throw new Error(
    "Google credentials are not configured. Set GOOGLE_CREDENTIALS_JSON on Vercel or add dashboard/credentials.json locally.",
  );
}

async function getAccessToken() {
  const credentials = await loadCredentials();
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google credentials must include client_email and private_key.");
  }

  const client = new JWT({
    email: credentials.client_email,
    key: fixPrivateKey(credentials.private_key),
    scopes: [SHEETS_SCOPE],
  });

  const accessToken = await client.getAccessToken();
  if (!accessToken.token) {
    throw new Error("Could not obtain a Google API access token.");
  }

  return accessToken.token;
}

async function sheetsFetch<T>(url: string): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Sheets API returned ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json() as Promise<T>;
}

function quoteSheetName(sheetName: string) {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function uniqueHeaders(headers: string[]) {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const clean = header.trim() || "Column";
    const count = seen.get(clean) ?? 0;
    seen.set(clean, count + 1);
    return count === 0 ? clean : `${clean}_${count}`;
  });
}

function parseNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: string | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapHeader(header: string, index: number) {
  const lower = header.toLowerCase();
  if (lower.includes("timestamp") && index === 0) return "receivedAt";
  if (lower.includes("temperature")) return "temperature";
  if (lower.includes("humidity")) return "humidity";
  if (lower.includes("device")) return "deviceId";
  if (lower.includes("timestamp") && index > 0) return "deviceTimestamp";
  return null;
}

function normalizeRows(values: string[][], limit: number): Reading[] {
  if (values.length < 2) return [];

  const headers = uniqueHeaders(values[0]);
  const mappings = headers.map(mapHeader);

  const readings = values.slice(1).flatMap((row, index) => {
    const record: Record<string, string> = {};
    row.forEach((value, cellIndex) => {
      const key = mappings[cellIndex];
      if (key) record[key] = value;
    });

    const temperature = parseNumber(record.temperature);
    const humidity = parseNumber(record.humidity);
    if (temperature === null || humidity === null) return [];

    const deviceTimestampMs = parseTimestamp(record.deviceTimestamp);
    const receivedAtMs = parseTimestamp(record.receivedAt);
    const timestampMs = deviceTimestampMs ?? receivedAtMs;

    return {
      id: index + 2,
      sheetRow: index + 2,
      temperature,
      humidity,
      deviceId: record.deviceId || "unknown",
      receivedAt: record.receivedAt || null,
      deviceTimestamp: record.deviceTimestamp || null,
      timestamp: timestampMs ? new Date(timestampMs).toISOString() : null,
      timestampMs,
    } satisfies Reading;
  });

  return readings
    .sort((a, b) => {
      if (a.timestampMs && b.timestampMs) return b.timestampMs - a.timestampMs;
      if (a.timestampMs) return -1;
      if (b.timestampMs) return 1;
      return b.sheetRow - a.sheetRow;
    })
    .slice(0, limit);
}

export async function loadReadings(limit = 5000): Promise<ReadingsResponse> {
  const spreadsheetId = getSpreadsheetId();
  const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(title))`;
  const metadata = await sheetsFetch<SpreadsheetMetadataResponse>(metadataUrl);
  const sheetTitle = metadata.sheets?.[0]?.properties?.title;

  if (!sheetTitle) {
    throw new Error("Could not find the first sheet in the Google spreadsheet.");
  }

  const range = `${quoteSheetName(sheetTitle)}!A:Z`;
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
    range,
  )}?majorDimension=ROWS`;
  const sheetValues = await sheetsFetch<SheetValuesResponse>(valuesUrl);
  const values = sheetValues.values ?? [];
  const readings = normalizeRows(values, limit);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    sheetTitle,
    rowsLoaded: Math.max(values.length - 1, 0),
    readings,
  };
}
