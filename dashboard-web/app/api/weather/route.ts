import { NextResponse } from "next/server";
import { loadOfficialWeather, isWeatherConfigured } from "@/lib/weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET() {
  if (!isWeatherConfigured()) {
    return NextResponse.json({ ok: true, configured: false });
  }

  try {
    const weather = await loadOfficialWeather();
    return NextResponse.json(
      { ok: true, configured: true, ...weather },
      {
        headers: {
          // Open-Meteo's current-conditions data itself only refreshes every
          // 15-60 min, so cache well past the dashboard's own poll interval.
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
        error: error instanceof Error ? error.message : "Unknown error loading weather",
      },
      { status: 500 },
    );
  }
}
