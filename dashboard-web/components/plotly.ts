export type PlotlyApi = typeof import("plotly.js");

// The div Plotly.react attaches to gets `on`/`removeAllListeners` methods
// bolted on. Type them narrowly so we don't need to `as any` every time we
// wire up an event listener.
export type PlotlyEventDiv = HTMLDivElement & {
  on(name: string, handler: (e: Record<string, unknown>) => void): void;
  removeAllListeners(name: string): void;
};

// Plotly's plotly_relayout event usually delivers date-axis range values as
// strings, but versions have varied (numbers, Date objects). Normalise so
// callers can safely store `[string, string]`.
export function normalizeAxisValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

let plotlyPromise: Promise<PlotlyApi> | null = null;

export function loadPlotly(): Promise<PlotlyApi> {
  if (!plotlyPromise) {
    plotlyPromise = import("plotly.js-basic-dist-min").then(
      (mod) => (mod as { default?: PlotlyApi }).default ?? (mod as unknown as PlotlyApi),
    );
  }
  return plotlyPromise;
}

// Purge a chart's Plotly state on unmount, without loading Plotly just
// to do so when no chart ever rendered.
export function purgePlot(element: HTMLElement) {
  plotlyPromise?.then((Plotly) => Plotly.purge(element));
}
