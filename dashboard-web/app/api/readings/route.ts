import { NextResponse } from "next/server";
import { loadReadings } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

function parseIntParam(value: string | null, fallback: number, min: number, max: number) {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // `range_hours` is the new primary parameter. Accept "all" (or empty) to
  // disable the window and fall back to the legacy `limit` cap. Older callers
  // that only pass `limit` keep working.
  const rangeParam = searchParams.get("range_hours");
  let rangeHours: number | null = null;
  if (rangeParam !== null && rangeParam !== "" && rangeParam !== "all") {
    const n = Number(rangeParam);
    if (Number.isFinite(n) && n > 0) {
      rangeHours = Math.min(n, 24 * 365); // sanity cap: one year
    }
  }

  const limit = parseIntParam(searchParams.get("limit"), 5000, 1, 20000);
  const maxPoints = parseIntParam(searchParams.get("max_points"), 2000, 100, 10000);

  try {
    const data = await loadReadings({ rangeHours, limit, maxPoints });
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "max-age=10",
        "CDN-Cache-Control": "max-age=30",
        "Vercel-CDN-Cache-Control": "max-age=30",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Google Sheets error",
      },
      { status: 500 },
    );
  }
}
