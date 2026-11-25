// Shapes shared by the API routes (server) and the dashboard page (client).
// Type-only: importing this module never pulls server code into the bundle.

export type Reading = {
  id: number;
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
  rowsInRange: number;
  stride: number;
  rangeHours: number | null;
  readings: Reading[];
  /**
   * Newest reading overall, ignoring `rangeHours`. Lets the UI detect an
   * outage that's longer than the selected window, when `readings` is empty.
   */
  latest: Reading | null;
  /**
   * When the Telegram stale-check last ran (alert_state.last_checked_at),
   * or null when unknown (schema without the column).
   */
  alertsCheckedAt: string | null;
};

export type LoadReadingsOptions = {
  /**
   * Time window in hours from now. `null` means no window (use `limit` instead).
   * When set, rows older than `Date.now() - rangeHours * 3600_000` are dropped
   * before downsampling.
   */
  rangeHours?: number | null;
  /**
   * Hard cap on rows returned when no `rangeHours` is given. Ignored when a
   * window is active.
   */
  limit?: number;
  /**
   * Target maximum number of points returned after stride downsampling. The
   * stride is `ceil(rowsInWindow / maxPoints)`, so the actual output may be a
   * bit smaller than this.
   */
  maxPoints?: number;
};

/** What GET /api/readings returns. */
export type ApiResponse = ReadingsResponse | { ok: false; error: string };

/** What GET /api/weather returns. */
export type WeatherResponse =
  | { ok: true; configured: false }
  | {
      ok: true;
      configured: true;
      temperature: number;
      humidity: number;
      observedAt: string;
    }
  | { ok: false; error: string };

/** What GET /api/weather/history returns. */
export type WeatherHistoryResponse =
  | { ok: true; points: { temperature: number; humidity: number; observedAt: string }[] }
  | { ok: false; error: string };
