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

const PAGE_SIZE = 1_000;
// Only used by the bare `?limit=N` legacy path below, which is rare and
// bounded by definition; the range/all paths downsample in Postgres instead
// of paginating the whole table.
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

// Newest first; rows without a resolvable timestamp fall to the back.
// Re-sorting (rather than trusting query order) guards against
// device_ts/received_at drift, mirroring sheets.ts.
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

async function fetchExactCount(
  config: { url: string; key: string },
  cutoffIso: string | null,
): Promise<number> {
  const params = new URLSearchParams({ select: "id", limit: "1" });
  if (cutoffIso) params.append("received_at", `gte.${cutoffIso}`);
  const res = await fetch(`${config.url}/rest/v1/readings?${params}`, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      Prefer: "count=exact",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const range = res.headers.get("content-range"); // e.g. "0-0/76612"
  const total = range ? Number(range.split("/")[1]) : NaN;
  if (!Number.isFinite(total)) throw new Error("Supabase did not return an exact row count.");
  return total;
}

async function fetchDownsampled(
  config: { url: string; key: string },
  cutoffIso: string | null,
  targetPoints: number,
): Promise<SupabaseRow[]> {
  // PostgREST doesn't paginate `setof` RPC results via Range headers (it
  // silently returned the same first chunk on every page when tested), so
  // page_offset/page_limit are function arguments handled inside the SQL
  // instead. Still bounded by targetPoints (a small constant), not table
  // size, which is the whole point of downsampling in SQL.
  const url = `${config.url}/rest/v1/rpc/readings_downsampled`;
  const rows: SupabaseRow[] = [];
  for (let offset = 0; offset < targetPoints; offset += PAGE_SIZE) {
    const pageLimit = Math.min(PAGE_SIZE, targetPoints - offset);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_points: targetPoints,
        cutoff: cutoffIso,
        page_offset: offset,
        page_limit: pageLimit,
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Supabase downsample query failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const page = (await res.json()) as SupabaseRow[];
    if (page.length === 0) break;
    rows.push(...page);
    if (page.length < pageLimit) break;
  }
  return rows;
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
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      sheetTitle: "Supabase",
      rowsLoaded: readings.length,
      rowsInRange: readings.length,
      stride: 1,
      rangeHours,
      readings,
    };
  }

  // Range / "all" path: downsample in Postgres (readings_downsampled, from
  // scripts/supabase-schema.sql) so the payload stays ~maxPoints rows no
  // matter how large the table gets, instead of paginating everything over
  // HTTP and thinning it out here.
  const cutoffIso = rangeHours !== null && rangeHours > 0
    ? new Date(Date.now() - rangeHours * 3_600_000).toISOString()
    : null;

  const [rowsInRange, rows] = await Promise.all([
    fetchExactCount(config, cutoffIso),
    fetchDownsampled(config, cutoffIso, maxPoints),
  ]);

  const readings = sortNewestFirst(rows.map(toReading));
  const stride = readings.length > 0 ? Math.max(1, Math.round(rowsInRange / readings.length)) : 1;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    sheetTitle: "Supabase",
    rowsLoaded: rowsInRange,
    rowsInRange,
    stride,
    rangeHours,
    readings,
  };
}
