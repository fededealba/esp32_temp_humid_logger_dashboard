// A small versioned cache in localStorage, so the dashboard can show the
// last readings the moment it opens (on a phone, after the server has gone
// cold, the first fresh response can take several seconds) and refresh them
// in the background. Every failure -- storage disabled, quota exceeded,
// corrupt or outdated entry -- degrades to "no cache", never an error.

// Bump when the cached shapes change, so old entries are ignored rather than
// misread.
const VERSION = 1;
const PREFIX = "esp32-dashboard:";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // e.g. Safari private mode, or storage blocked
  }
}

export function loadCached<T>(key: string, store: StorageLike | null = storage()): { value: T; savedAt: number } | null {
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { v?: number; savedAt?: number; value?: T };
    if (entry.v !== VERSION || typeof entry.savedAt !== "number" || entry.value === undefined) return null;
    return { value: entry.value, savedAt: entry.savedAt };
  } catch {
    return null;
  }
}

export function saveCached<T>(key: string, value: T, store: StorageLike | null = storage(), now = Date.now()): void {
  if (!store) return;
  try {
    store.setItem(PREFIX + key, JSON.stringify({ v: VERSION, savedAt: now, value }));
  } catch {
    // Quota exceeded: drop this entry rather than keep a stale one around.
    try {
      store.removeItem(PREFIX + key);
    } catch {
      /* nothing else to do */
    }
  }
}
