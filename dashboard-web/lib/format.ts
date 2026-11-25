import type { Reading } from "./types";

/** A duration as "5 min", "2 h 10 min", or "3 d 4 h". */
export function formatAge(ms: number) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days} d ${restHours} h` : `${days} d`;
  }
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** How long ago, for status lines: "just now", "4 min ago". */
export function formatAgo(ms: number) {
  return ms < 60_000 ? "just now" : `${formatAge(ms)} ago`;
}

export function formatNumber(value: number, digits = 1) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

// 24-hour times throughout, matching the charts' axis and hover labels.
// en-GB gives "25 Nov" day-month order, which reads naturally with 24h time.
const dayKey = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(ms));

/** "16:21" when `ms` falls on the same calendar day as `nowMs` in `timeZone`, else "24 Nov 16:21". */
export function formatShortTime(ms: number, timeZone: string, nowMs = Date.now()) {
  const sameDay = dayKey(ms, timeZone) === dayKey(nowMs, timeZone);
  return new Intl.DateTimeFormat("en-GB", {
    ...(sameDay ? {} : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(ms)).replace(",", "");
}

export function formatTime(reading: Reading, timezone: string) {
  if (!reading.timestampMs) return "No timestamp";
  return formatShortTime(reading.timestampMs, timezone);
}
