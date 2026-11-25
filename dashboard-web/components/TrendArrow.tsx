import type { Trend } from "@/lib/trends";

export function TrendArrow({ trend }: { trend: Trend }) {
  if (trend === null) return null;
  const symbol = trend === "up" ? "▲" : trend === "down" ? "▼" : "→";
  const label = trend === "up" ? "increasing" : trend === "down" ? "decreasing" : "stable";
  return (
    <span className="trend-arrow" title={`${label} over the last 10 min`} aria-label={label}>
      {symbol}
    </span>
  );
}
