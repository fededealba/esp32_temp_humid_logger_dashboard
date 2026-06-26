import { NextResponse } from "next/server";
import { loadReadings as loadFromSheets } from "@/lib/sheets";
import { loadReadings as loadFromDb, isSupabaseConfigured } from "@/lib/db";

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

  // `range_hours` is the new primary parameter:
  //   range_hours=<n>  -> window of n hours
  //   range_hours=all  -> no window AND no row cap (downsampling bounds size)
  //   (missing)        -> legacy mode: respect `limit` (default 5000)
  const rangeParam = searchParams.get("range_hours");
  const maxPoints = parseIntParam(searchParams.get("max_points"), 2000, 100, 10000);

  let rangeHours: number | null = null;
  let limit = parseIntParam(searchParams.get("limit"), 5000, 1, 20000);

  if (rangeParam === "all") {
    // Show everything; rely on stride downsampling to keep the payload sane.
    limit = Number.MAX_SAFE_INTEGER;
  } else if (rangeParam !== null && rangeParam !== "") {
    const n = Number(rangeParam);
    if (Number.isFinite(n) && n > 0) {
      rangeHours = Math.min(n, 24 * 365); // sanity cap: one year
    }
  }

  // Use Supabase when configured; fall back to Google Sheets otherwise.
  const loadReadings = isSupabaseConfigured() ? loadFromDb : loadFromSheets;

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
        error: error instanceof Error ? error.message : "Unknown error loading readings",
      },
      { status: 500 },
    );
  }
}
