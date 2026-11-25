import type { ReadingsResponse, LoadReadingsOptions, Reading } from "./types";

export type { ReadingsResponse, LoadReadingsOptions, Reading };

type SupabaseRow = {
  id: number;
  device_id: string;
  temperature: number;
  humidity: number;
  device_ts: string | null;
  received_at: string | null;
};

// Page size and row cap for the bare `?limit=N` legacy path below, which is
// rare and bounded by definition; the range/all paths downsample in Postgres
// in a single call instead.
const PAGE_SIZE = 1_000;
const MAX_ROWS = 20_000;

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
    temperature: row.temperature,
    humidity: row.humidity,
    deviceId: row.device_id,
    receivedAt: row.received_at,
    deviceTimestamp: row.device_ts,
    timestamp: timestampMs ? new Date(timestampMs).toISOString() : null,
    timestampMs,
  };
}

// Newest first; rows without a resolvable timestamp fall to the back.
// Re-sorting (rather than trusting query order) guards against
// device_ts/received_at drift.
function sortNewestFirst(readings: Reading[]): Reading[] {
  return [...readings].sort((a, b) => {
    if (a.timestampMs !== null && b.timestampMs !== null) return b.timestampMs - a.timestampMs;
    if (a.timestampMs !== null) return -1;
    if (b.timestampMs !== null) return 1;
    return b.id - a.id;
  });
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

// Newest row in the whole table, ignoring any time window, so the dashboard
// can still flag an outage that's longer than the selected range (in which
// case the windowed result is empty). Cheap: served by readings_received_at_idx.
async function fetchLatest(config: { url: string; key: string }): Promise<Reading | null> {
  const params = new URLSearchParams({
    select: "id,device_id,temperature,humidity,device_ts,received_at",
    order: "received_at.desc",
  });
  const [row] = await fetchPage(`${config.url}/rest/v1/readings?${params}`, config.key, 0, 0);
  return row ? toReading(row) : null;
}

// Heartbeat written by scripts/check-stale.mjs on every run. Best-effort:
// any failure (older schema without the column, missing table) yields null,
// which the dashboard treats as "unknown" rather than as a warning, and
// never fails the readings request itself.
async function fetchAlertsCheckedAt(config: { url: string; key: string }): Promise<string | null> {
  try {
    const res = await fetch(`${config.url}/rest/v1/alert_state?select=last_checked_at&id=eq.1`, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const [row] = (await res.json()) as { last_checked_at?: string | null }[];
    return row?.last_checked_at ?? null;
  } catch {
    return null;
  }
}

// One call to readings_downsampled_json (scripts/supabase-schema.sql): the
// per-device stride sample of everything since `cutoff`, plus the exact
// in-range row count. It returns a single JSON value rather than a row set,
// so Supabase's 1,000-row API cap doesn't apply and no paging is needed --
// the old paged function re-ran the full window computation per page, which
// made "all time" take ~5s at ~480k rows.
async function fetchDownsampled(
  config: { url: string; key: string },
  cutoffIso: string | null,
  targetPoints: number,
): Promise<{ rows: SupabaseRow[]; totalInRange: number }> {
  const res = await fetch(`${config.url}/rest/v1/rpc/readings_downsampled_json`, {
    method: "POST",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target_points: targetPoints, cutoff: cutoffIso }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase downsample query failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { rows?: SupabaseRow[]; total_in_range?: number };
  if (!Array.isArray(body.rows) || typeof body.total_in_range !== "number") {
    throw new Error("Supabase downsample query returned an unexpected shape.");
  }
  return { rows: body.rows, totalInRange: body.total_in_range };
}

export async function loadReadings(
  options: LoadReadingsOptions = {},
): Promise<ReadingsResponse> {
  const config = getConfig();
  if (!config) throw new Error("Supabase is not configured.");

  const { rangeHours = null, limit = 5000, maxPoints = 2000 } = options;

  // Bare `?limit=N` with no time window: return the N most recent raw rows,
  // unsampled. This is a legacy shape kept for direct API callers — the
  // dashboard UI always sends `range_hours`, which takes the downsampled
  // path below regardless of table size.
  if (rangeHours === null && limit < Number.MAX_SAFE_INTEGER) {
    const rowCap = Math.min(Math.max(1, limit), MAX_ROWS);
    const params = new URLSearchParams({
      select: "id,device_id,temperature,humidity,device_ts,received_at",
      order: "received_at.desc",
    });
    const baseUrl = `${config.url}/rest/v1/readings?${params}`;
    const allRows: SupabaseRow[] = [];
    for (let from = 0; from < rowCap; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE - 1, rowCap - 1);
      const page = await fetchPage(baseUrl, config.key, from, to);
      if (page.length === 0) break;
      allRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    const readings = sortNewestFirst(allRows.map(toReading));
    const alertsCheckedAt = await fetchAlertsCheckedAt(config);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      rowsInRange: readings.length,
      stride: 1,
      rangeHours,
      readings,
      latest: readings[0] ?? null,
      alertsCheckedAt,
    };
  }

  // Range / "all" path: downsample in Postgres so the payload stays
  // ~maxPoints rows per device no matter how large the table gets.
  const cutoffIso = rangeHours !== null && rangeHours > 0
    ? new Date(Date.now() - rangeHours * 3_600_000).toISOString()
    : null;

  const [{ rows, totalInRange: rowsInRange }, latest, alertsCheckedAt] = await Promise.all([
    fetchDownsampled(config, cutoffIso, maxPoints),
    fetchLatest(config),
    fetchAlertsCheckedAt(config),
  ]);

  const readings = sortNewestFirst(rows.map(toReading));
  const stride = readings.length > 0 ? Math.max(1, Math.round(rowsInRange / readings.length)) : 1;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    rowsInRange,
    stride,
    rangeHours,
    readings,
    latest,
    alertsCheckedAt,
  };
}
