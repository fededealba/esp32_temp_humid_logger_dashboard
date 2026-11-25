// The DHT22 is wired to the ESP32 itself, so its rows are posted under the
// board's WiFi MAC address ("F8:B3:B7:48:AD:04"); Bluetooth sensors post
// under their advertised name ("TP357 (BEAE)"). The MAC is unreadable on a
// phone, so it's shown as "DHT22" plus the last two MAC bytes, which keeps
// boards distinguishable if a second one is ever added.
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

export function deviceLabel(deviceId: string): string {
  if (MAC.test(deviceId)) return `DHT22 (${deviceId.slice(-5).replace(":", "")})`;
  return deviceId;
}
