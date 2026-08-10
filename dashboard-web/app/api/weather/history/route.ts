import { NextResponse } from "next/server";
import { loadOfficialWeatherHistory } from "@/lib/weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rangeParam = searchParams.get("range_hours");

  let rangeHours: number | null = null;
  if (rangeParam !== null && rangeParam !== "" && rangeParam !== "all") {
    const n = Number(rangeParam);
    if (Number.isFinite(n) && n > 0) rangeHours = Math.min(n, 24 * 365);
  }

  try {
    const points = await loadOfficialWeatherHistory(rangeHours);
    return NextResponse.json(
      { ok: true, points },
      {
        headers: {
          // Matches /api/weather's own cache window -- this table only
          // grows one row every ~30 min via scripts/log-weather.mjs.
          "Cache-Control": "max-age=300",
          "CDN-Cache-Control": "max-age=600",
          "Vercel-CDN-Cache-Control": "max-age=600",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error loading weather history",
      },
      { status: 500 },
    );
  }
}
