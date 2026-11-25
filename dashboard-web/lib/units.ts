export function toFahrenheit(celsius: number) {
  return celsius * 1.8 + 32;
}

// For a *difference* between two Celsius readings, not an absolute value —
// skips the +32 offset (which would cancel out anyway, but this makes the
// intent explicit at call sites instead of relying on that cancellation).
export function toFahrenheitDelta(deltaCelsius: number) {
  return deltaCelsius * 1.8;
}
