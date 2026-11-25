import type { Reading } from "./types";

// A received_at that carries its own zone (Supabase returns e.g.
// "2026-11-24T11:53:13.123+00:00") is an unambiguous instant. Anything
// zone-less would be parsed in the viewer's timezone, so it's not trusted
// and the resolved timestamp is used instead.
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * When a reading arrived, for staleness checks: received_at (stamped by the
 * database's clock) when it's an unambiguous instant, else the resolved
 * timestamp. Preferring received_at means an ESP32 whose clock hasn't synced
 * yet, or has drifted, can't trigger or hide the offline warning.
 */
export function arrivalMs(reading: Reading): number | null {
  const received = reading.receivedAt;
  if (received && HAS_ZONE.test(received)) {
    const ms = Date.parse(received);
    if (Number.isFinite(ms)) return ms;
  }
  return reading.timestampMs;
}

/** The reading that arrived most recently, or null if none has a usable time. */
export function newestByArrival(readings: Reading[]): Reading | null {
  let best: Reading | null = null;
  let bestMs = -Infinity;
  for (const reading of readings) {
    const ms = arrivalMs(reading);
    if (ms !== null && ms > bestMs) {
      best = reading;
      bestMs = ms;
    }
  }
  return best;
}
