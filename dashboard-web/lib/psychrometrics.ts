// Rothfusz regression of Steadman's heat-index table. Only meaningful above
// ~27 °C; below that the perceived temperature is essentially the air temp.
export function heatIndexCelsius(tempC: number, humidity: number): number {
  if (tempC < 26.7) return tempC;
  const T = tempC * 9 / 5 + 32;
  const R = humidity;
  const hiF =
    -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
    - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
    + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
  return ((hiF - 32) * 5) / 9;
}

// August-Roche-Magnus approximation, accurate to within ~0.4°C for
// -45..60°C. Same family of formula the heat index above is tuned from.
export function dewPointCelsius(tempC: number, humidity: number): number {
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(humidity / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

// Saturation vapor pressure (Magnus formula) scaled to actual vapor
// pressure by RH, then converted to a mass concentration via the ideal gas
// law for water vapor. Returns grams of water vapor per cubic meter of air.
export function absoluteHumidity(tempC: number, humidity: number): number {
  const satVaporPressureHpa = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
  const vaporPressureHpa = (humidity / 100) * satVaporPressureHpa;
  return (216.7 * vaporPressureHpa) / (tempC + 273.15);
}
