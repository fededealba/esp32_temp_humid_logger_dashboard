// Cadence the ESP32 firmware posts at (BASE_INTERVAL_MS). Drives both the
// staleness threshold and the chart-gap detection floor.
export const POST_INTERVAL_MS = 60 * 1000;
// Warn when the newest reading is older than ~5 missed posts.
export const STALE_AFTER_MS = 5 * POST_INTERVAL_MS;
