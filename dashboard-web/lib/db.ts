import type { ReadingsResponse, LoadReadingsOptions, Reading } from "./sheets";

export type { ReadingsResponse, LoadReadingsOptions, Reading };

type SupabaseRow = {
  id: number;
  device_id: string;
  temperature: number;
  humidity: number;
  device_ts: string | null;
  received_at: string | null;
};

function getConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

export function isSupabaseConfigured(): boolean {
  return getConfig() !== null;
}

function toReading(row: SupabaseRow): Reading {
  const deviceTsMs = row.device_ts ? Date.parse(row.device_ts) : null;
  const receivedAtMs = row.received_at ? Date.parse(row.received_at) : null;
  const timestampMs = (Number.isFinite(deviceTsMs) ? deviceTsMs : null)
    ?? (Number.isFinite(receivedAtMs) ? receivedAtMs : null);
  return {
    id: row.id,
    sheetRow: row.id,
    temperature: row.temperature,
    humidity: row.humidity,
    deviceId: row.device_id,
    receivedAt: row.received_at,
    deviceTimestamp: row.device_ts,
    timestamp: timestampMs ? new Date(timestampMs).toISOString() : null,
    timestampMs,
  };
}

function downsampleByStride(
  readings: Reading[],
  maxPoints: number,
): { rows: Reading[]; stride: number } {
  if (readings.length <= maxPoints || maxPoints <= 0) {
    return { rows: readings, stride: 1 };
  }
  const stride = Math.ceil(readings.length / maxPoints);
  const rows: Reading[] = [];
  for (let i = 0; i < readings.length; i += stride) rows.push(readings[i]);
  return { rows, stride };
}

async function fetchPage(
  url: string,
  key: string,
  from: number,
  to: number,
): Promise<SupabaseRow[]> {
  const res = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Range: `${from}-${to}`,
      "Range-Unit": "items",
      Prefer: "count=none",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<SupabaseRow[]>;
}

export async function loadReadings(
  options: LoadReadingsOptions = {},
): Promise<ReadingsResponse> {
  const config = getConfig();
  if (!config) throw new Error("Supabase is not configured.");

  const { rangeHours = null, limit = 5000, maxPoints = 2000 } = options;

  const params = new URLSearchParams({
    select: "*",
    order: "received_at.desc",
  });

  if (rangeHours !== null && rangeHours > 0) {
    const cutoff = new Date(Date.now() - rangeHours * 3_600_000).toISOString();
    params.append("received_at", `gte.${cutoff}`);
  }

  const baseUrl = `${config.url}/rest/v1/readings?${params}`;

  // Paginate in 1 000-row pages up to the effective row cap.
  const rowCap = rangeHours !== null ? 50_000 : Math.max(1, limit);
  const pageSize = 1_000;
  const allRows: SupabaseRow[] = [];

  for (let from = 0; from < rowCap; from += pageSize) {
    const to = Math.min(from + pageSize - 1, rowCap - 1);
    const page = await fetchPage(baseUrl, config.key, from, to);
    allRows.push(...page);
    if (page.length < pageSize) break; // last page
  }

  const allReadings = allRows.map(toReading);

  // Mirror the windowing + downsampling logic from sheets.ts.
  let windowed = allReadings;
  if (rangeHours !== null && rangeHours > 0) {
    const cutoff = Date.now() - rangeHours * 3_600_000;
    windowed = allReadings.filter(
      (r) => r.timestampMs !== null && r.timestampMs >= cutoff,
    );
  }

  const { rows: readings, stride } = downsampleByStride(windowed, maxPoints);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    sheetTitle: "Supabase",
    rowsLoaded: allRows.length,
    rowsInRange: windowed.length,
    stride,
    rangeHours,
    readings,
  };
}
