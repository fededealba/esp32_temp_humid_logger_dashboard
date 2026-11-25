export type GapPoint = {
  /** Epoch ms. */
  t: number;
  /** null marks a deliberate break in the line. */
  value: number | null;
  /** True for readings right before or after a gap, so they stay visible. */
  marker: boolean;
};

/**
 * Prepares one device's time series for a line chart that shouldn't draw a
 * straight segment across an outage. A gap is any spacing over
 * max(3 x the series' median spacing, 3 x minIntervalMs): the median adapts
 * to downsampled data (a 7-day view has wider spacing than the raw cadence),
 * and the floor keeps ordinary jitter at the raw cadence from counting.
 * A null point is inserted mid-gap (Plotly breaks the line there), and the
 * readings on either side get a marker so isolated points don't vanish.
 *
 * Expects `timestamps` sorted oldest first, aligned with `values`. Call it per
 * device: mixing two devices' cadences would misdetect gaps.
 */
export function withGapBreaks(timestamps: number[], values: number[], minIntervalMs: number): GapPoint[] {
  const dts: number[] = [];
  for (let i = 1; i < timestamps.length; i++) dts.push(timestamps[i] - timestamps[i - 1]);
  const sortedDts = dts.slice().sort((a, b) => a - b);
  const medianDt = sortedDts.length > 0 ? sortedDts[Math.floor(sortedDts.length / 2)] : minIntervalMs;
  const gapThreshold = Math.max(3 * medianDt, 3 * minIntervalMs);

  const points: GapPoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const prevGap = i > 0 && t - timestamps[i - 1] > gapThreshold;
    const nextGap = i + 1 < timestamps.length && timestamps[i + 1] - t > gapThreshold;
    points.push({ t, value: values[i], marker: prevGap || nextGap });
    if (nextGap) points.push({ t: (t + timestamps[i + 1]) / 2, value: null, marker: false });
  }
  return points;
}
