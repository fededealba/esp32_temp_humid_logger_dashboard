import { describe, it, expect } from "vitest";
import { arrivalMs, newestByArrival } from "./freshness";
import type { Reading } from "./types";

function reading(overrides: Partial<Reading>): Reading {
  return {
    id: 1,
    temperature: 20,
    humidity: 50,
    deviceId: "AA:BB",
    receivedAt: null,
    deviceTimestamp: null,
    timestamp: null,
    timestampMs: null,
    ...overrides,
  };
}

describe("lib/freshness", () => {
  it("prefers received_at over a drifted device timestamp", () => {
    const r = reading({
      receivedAt: "2026-11-24T12:00:00.000+00:00",
      timestampMs: Date.parse("2026-11-24T11:40:00Z"), // device clock 20 min slow
    });
    expect(arrivalMs(r)).toBe(Date.parse("2026-11-24T12:00:00Z"));
  });

  it("accepts a Z suffix and offsets without a colon", () => {
    expect(arrivalMs(reading({ receivedAt: "2026-11-24T12:00:00Z" }))).toBe(Date.parse("2026-11-24T12:00:00Z"));
    expect(arrivalMs(reading({ receivedAt: "2026-11-24T13:00:00+0100" }))).toBe(Date.parse("2026-11-24T12:00:00Z"));
  });

  it("falls back to the resolved timestamp for zone-less times", () => {
    const r = reading({ receivedAt: "6/1/2026 10:00:00", timestampMs: 123 });
    expect(arrivalMs(r)).toBe(123);
  });

  it("falls back when received_at is missing or unparseable", () => {
    expect(arrivalMs(reading({ timestampMs: 456 }))).toBe(456);
    expect(arrivalMs(reading({ receivedAt: "garbageZ", timestampMs: 789 }))).toBe(789);
    expect(arrivalMs(reading({}))).toBeNull();
  });

  it("picks the newest by arrival, not by device timestamp", () => {
    // `a` claims a later device time (fast clock) but actually arrived first.
    const a = reading({ id: 1, receivedAt: "2026-11-24T12:00:00Z", timestampMs: Date.parse("2026-11-24T13:00:00Z") });
    const b = reading({ id: 2, receivedAt: "2026-11-24T12:01:00Z", timestampMs: Date.parse("2026-11-24T12:01:00Z") });
    expect(newestByArrival([a, b])?.id).toBe(2);
    expect(newestByArrival([])).toBeNull();
    expect(newestByArrival([reading({})])).toBeNull();
  });
});
