import { describe, it, expect } from "vitest";
import { loadCached, saveCached } from "./cache";
import { deviceLabel } from "./devices";
import { formatAge, formatAgo, formatShortTime } from "./format";

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("cache", () => {
  it("round-trips a value with the time it was saved", () => {
    const store = memoryStore();
    saveCached("readings:24", { n: 1 }, store, 1234);
    expect(loadCached("readings:24", store)).toEqual({ value: { n: 1 }, savedAt: 1234 });
  });

  it("treats missing, corrupt or other-version entries as no cache", () => {
    const store = memoryStore();
    expect(loadCached("nope", store)).toBeNull();
    store.map.set("esp32-dashboard:bad", "{not json");
    expect(loadCached("bad", store)).toBeNull();
    store.map.set("esp32-dashboard:old", JSON.stringify({ v: 0, savedAt: 1, value: {} }));
    expect(loadCached("old", store)).toBeNull();
  });

  it("drops the entry instead of throwing when storage is full", () => {
    const store = memoryStore();
    store.map.set("esp32-dashboard:k", "stale");
    const full = { ...store, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(() => saveCached("k", { big: true }, full)).not.toThrow();
    expect(store.map.has("esp32-dashboard:k")).toBe(false);
  });

  it("is a no-op without storage (server render, blocked storage)", () => {
    expect(loadCached("k", null)).toBeNull();
    expect(() => saveCached("k", 1, null)).not.toThrow();
  });
});

describe("deviceLabel", () => {
  it("names the ESP32's own DHT22 by its MAC suffix", () => {
    expect(deviceLabel("F8:B3:B7:48:AD:04")).toBe("DHT22 (AD04)");
    expect(deviceLabel("f8:b3:b7:48:ad:04")).toBe("DHT22 (ad04)");
  });

  it("keeps Bluetooth sensor names as they are", () => {
    expect(deviceLabel("TP357 (BEAE)")).toBe("TP357 (BEAE)");
    expect(deviceLabel("unknown")).toBe("unknown");
  });
});

describe("time formatting", () => {
  const now = Date.parse("2026-11-25T15:30:00Z"); // 16:30 in Paris

  it("shows just the time for today, and the date otherwise", () => {
    expect(formatShortTime(Date.parse("2026-11-25T15:21:00Z"), "Europe/Paris", now)).toBe("16:21");
    expect(formatShortTime(Date.parse("2026-11-24T15:21:00Z"), "Europe/Paris", now)).toBe("24 Nov 16:21");
  });

  it("decides 'today' in the display timezone, not UTC", () => {
    // 23:30 UTC on the 24th is already 00:30 on the 25th in Paris.
    expect(formatShortTime(Date.parse("2026-11-24T23:30:00Z"), "Europe/Paris", now)).toBe("00:30");
    expect(formatShortTime(Date.parse("2026-11-24T23:30:00Z"), "UTC", now)).toBe("24 Nov 23:30");
  });

  it("formats ages and 'ago' labels", () => {
    expect(formatAgo(30_000)).toBe("just now");
    expect(formatAgo(4 * 60_000)).toBe("4 min ago");
    expect(formatAge(26 * 3_600_000)).toBe("1 d 2 h");
    expect(formatAge(48 * 3_600_000)).toBe("2 d");
  });
});
