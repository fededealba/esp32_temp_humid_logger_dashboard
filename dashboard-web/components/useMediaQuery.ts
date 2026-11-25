import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query. On the client it's correct from the very first
 * render, so on a phone each chart is drawn once with its touch settings
 * rather than drawn for desktop and immediately redrawn.
 *
 * During prerendering there's no window, so the server assumes false. That's
 * safe only because no rendered markup depends on these values -- they feed
 * chart configuration applied in effects; sizes that differ per device live
 * in globals.css instead.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** Touch screens: no hover-revealed toolbar, and drags should scroll the page. */
export const TOUCH_QUERY = "(pointer: coarse)";
/** Phone-width layouts. Matches the breakpoint in globals.css. */
export const NARROW_QUERY = "(max-width: 680px)";
