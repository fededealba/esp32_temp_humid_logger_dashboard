// Per-device line colors for the temperature/humidity charts. Index 0 in
// each palette matches the original single-device color exactly, so nothing
// changes visually when only one device is present — additional devices
// cycle through the rest of the palette.
export const TEMP_COLORS = {
  light: ["#c2410c", "#be185d", "#b45309", "#7c2d12"],
  dark: ["#f97316", "#fb7185", "#fbbf24", "#fb923c"],
};
export const HUMIDITY_COLORS = {
  light: ["#087ea4", "#7c3aed", "#0d9488", "#4338ca"],
  dark: ["#38bdf8", "#a78bfa", "#2dd4bf", "#818cf8"],
};
// Area fill under the line only makes sense with a single trace; with two+
// devices overlapping semi-transparent fills just looks muddy, so it's only
// used when there's exactly one device.
export const TEMP_FILL = { light: "rgba(194, 65, 12, 0.12)", dark: "rgba(249, 115, 22, 0.18)" };
export const HUMIDITY_FILL = { light: "rgba(8, 126, 164, 0.12)", dark: "rgba(56, 189, 248, 0.18)" };
// Neutral (not orange/pink like TEMP_COLORS, not blue/purple like
// HUMIDITY_COLORS) so the official reference line reads as "background
// context" rather than another device.
export const OFFICIAL_COLOR = { light: "#78716c", dark: "#a8a29e" };
