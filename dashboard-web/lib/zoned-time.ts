// Inverse of `zonedDateString` for the purposes of comparison only. Treats
// the wall-clock string as UTC so the returned ms is offset by whatever the
// display timezone was — which is fine because both sides of any comparison
// go through this same function, so the offset cancels. Using this rather
// than raw string comparison protects against a future change to
// `zonedDateString`'s format (e.g. adding a weekday prefix) silently
// breaking chronological ordering.
export function zonedDateStringMs(s: string): number {
  return Date.parse(s.replace(" ", "T") + "Z");
}

// Plotly renders date values literally (as if UTC), so feed it wall-clock
// strings for the chosen timezone to make the axis and hover read in that zone.
export function zonedDateString(timestampMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestampMs));

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const hour = map.hour === "24" ? "00" : map.hour;
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}:${map.second}`;
}
