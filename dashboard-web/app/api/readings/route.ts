import { NextResponse } from "next/server";
import { loadReadings } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limitParam = Number(searchParams.get("limit") ?? "5000");
  const limit = Number.isFinite(limitParam)
    ? Math.max(1, Math.min(Math.trunc(limitParam), 20000))
    : 5000;

  try {
    const data = await loadReadings(limit);
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
