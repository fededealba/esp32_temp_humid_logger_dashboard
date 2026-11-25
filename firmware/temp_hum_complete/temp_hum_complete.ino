// Core
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include <NimBLEDevice.h>
#include <ArduinoOTA.h>
#include <time.h>
#include <string.h>
#if __has_include(<ArduinoJson.h>)
#include <ArduinoJson.h>
#define HAVE_ARDUINOJSON 1
#else
#define HAVE_ARDUINOJSON 0
#endif

// Secrets (optionally provided via secrets.h)
#if __has_include("secrets.h")
#include "secrets.h"  // should define WIFI_SSID, WIFI_PASSWORD, SUPABASE_URL, SUPABASE_ANON_KEY
#else
// Fallbacks (replace or create secrets.h)
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SUPABASE_URL = nullptr;             // e.g. https://xxxx.supabase.co ("" or nullptr disables)
const char* SUPABASE_ANON_KEY = nullptr;
#endif

// Google Forms submission URL (HTTPS)
const char* SERVER_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdaHQuuWAcFIjU44oZUqOMrtZhC9smcMoF9IOquQO8FFVwU5Q/formResponse";

// DHT22 setup
#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// Time: use system SNTP via configTime (UTC)
static const char* NTP_SERVERS[] = {"pool.ntp.org", "time.google.com", "time.nist.gov"};

// Timing
unsigned long lastScheduled = 0;                 // drift-free scheduler anchor
const unsigned long BASE_INTERVAL_MS = 60000UL;  // base interval between posts
const unsigned long MAX_BACKOFF_MS = 10UL * 60UL * 1000UL; // cap backoff at 10 minutes
uint8_t backoffExp = 0;                          // exponential backoff exponent (0..?)

// HTTP
const uint16_t HTTP_TIMEOUT_MS = 5000;

// Any clock reading before this (2020-01-01T00:00:00Z) means NTP hasn't
// synced yet and time() is still counting from 1970. Device timestamps are
// omitted until then, so the row falls back to the server's received_at
// (and the Supabase insert policy would reject a 1970 device_ts anyway).
const unsigned long MIN_VALID_EPOCH = 1577836800UL;

// DHT read retries
const uint8_t dhtMaxAttempts = 3;
const uint16_t dhtRetryDelayMs = 2000; // DHT22 prefers >=2s between attempts

// TP357 BLE sensor (ThermoPro): passively decoded from its advertisement,
// no pairing. Byte layout reverse-engineered by the community and verified
// against this exact unit; see thermopro-ble (Bluetooth-Devices org) for the
// reference decoder this is ported from.
const char* TP357_NAME_PREFIX = "TP357";
const uint32_t BLE_SCAN_MS = 5000; // TP357 advertises every ~2-3s

// Over-the-air updates (`make firmware-upload-ota`). Only enabled when
// secrets.h defines OTA_PASSWORD, so a build without one never listens for
// firmware uploads. Needs an OTA-capable partition scheme (min_spiffs, the
// Makefile default); the first flash after switching schemes must be USB.
const char* OTA_HOSTNAME = "esp32-weather"; // reachable as esp32-weather.local
bool otaStarted = false;

// Forward declarations
void connectWiFi();
void setupTime();
bool ensureTimeSync(uint8_t maxAttempts = 15);
bool readDHTStable(float &humidity, float &temperature);
String iso8601UTC(unsigned long epoch);
String hhmmssUTC(unsigned long epoch);
bool isPlausible(float humidity, float temperature);
String buildFormPayload(float humidity, float temperature, unsigned long epoch);
String buildSupabaseJsonPayload(const String &deviceId, float humidity, float temperature, unsigned long epoch);
bool postGoogleForms(float humidity, float temperature, unsigned long epoch);
bool postSupabase(const String &deviceId, float humidity, float temperature, unsigned long epoch);
bool decodeTP357ManufacturerData(const std::string &data, float &tempC, float &humidityPct);
bool scanForTP357(String &label, float &tempC, float &humidityPct);
unsigned long currentInterval();
void onWiFiEvent(WiFiEvent_t event);
void startOTA();
void handleOTA();

void setup() {
  Serial.begin(115200);

  connectWiFi();
  WiFi.onEvent(onWiFiEvent);
  WiFi.setAutoReconnect(true);
  startOTA(); // no-op until WiFi is up; retried from handleOTA()

  setupTime();
  dht.begin();

  // Wait briefly for the first NTP sync (bounded, ~4.5s max). If it isn't
  // there yet, SNTP keeps retrying in the background, and until it lands
  // readings go out without a device timestamp (see MIN_VALID_EPOCH).
  if (!ensureTimeSync()) {
    Serial.println("Warning: NTP time not available yet; SNTP will keep retrying.");
  }

  // BLE scanning coexists with WiFi (the ESP32 radio time-slices between
  // them automatically), as long as they aren't both actively transmitting
  // at the same instant — the loop always finishes the BLE scan before
  // making any HTTP requests, so they never overlap in practice.
  NimBLEDevice::init("esp32-dht22");
  NimBLEScan* bleScan = NimBLEDevice::getScan();
  bleScan->setActiveScan(true);
  bleScan->setInterval(100);
  bleScan->setWindow(100);

  lastScheduled = millis();
}

void loop() {
  // Keep WiFi alive
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, attempting reconnect...");
    connectWiFi();
  }
  handleOTA();
  unsigned long currentMillis = millis();

  // Interval scheduling, safe across millis() rollover (unsigned
  // subtraction). The anchor resets to now rather than advancing by
  // intervalMs, so a long blocking cycle never triggers back-to-back
  // catch-up posts; the cost is that the cycle's own duration adds to the
  // spacing between readings.
  unsigned long intervalMs = currentInterval();
  if ((long)(currentMillis - lastScheduled) >= (long)intervalMs) {
    lastScheduled = currentMillis;

    // Timestamp shared by both sensors' rows this cycle
    time_t now = time(nullptr);
    unsigned long epoch = (unsigned long)now;

    // Read the DHT22 (with retries). A failed or implausible read skips only
    // the DHT22 write: the TP357 scan below still runs, so one dead sensor
    // doesn't silence the other. Backoff is left untouched in that case,
    // since no network attempt was made.
    float humidity = NAN;
    float temperature = NAN;
    bool dhtOk = readDHTStable(humidity, temperature);
    if (!dhtOk) {
      Serial.println("Failed to read from DHT sensor after retries.");
    } else if (!isPlausible(humidity, temperature)) {
      Serial.println("Discarding implausible sensor reading.");
      dhtOk = false;
    }

    if (dhtOk) {
      String formattedTime = hhmmssUTC(epoch);     // HH:MM:SS (legacy)
      String timestampIso = iso8601UTC(epoch);     // ISO-8601 Zulu

      // Print to Serial
      Serial.println("Sending data to server(s)...");
      Serial.print("Temp: "); Serial.print(temperature);
      Serial.print(" °C  |  Humidity: "); Serial.print(humidity);
      Serial.print(" %  |  Time: "); Serial.print(formattedTime);
      Serial.print(" | ISO: "); Serial.println(timestampIso);
      Serial.print("Device IP: "); Serial.println(WiFi.localIP());

      // Write to both destinations independently; either one succeeding is
      // enough to reset the backoff, so a single flaky endpoint doesn't slow
      // down delivery to the other.
      bool sheetsOk = false;
      bool supabaseOk = false;
      if (WiFi.status() == WL_CONNECTED) {
        sheetsOk = postGoogleForms(humidity, temperature, epoch);
        supabaseOk = postSupabase(WiFi.macAddress(), humidity, temperature, epoch);
      }

      if (sheetsOk || supabaseOk) {
        backoffExp = 0; // at least one destination got the reading
      } else {
        if (backoffExp < 6) backoffExp++; // up to 2^6 = 64x
      }
    }

    // The cycle blocks for ~10-25s (DHT retries, HTTPS posts, BLE scan);
    // servicing OTA between phases keeps an upload attempt from timing out.
    handleOTA();

    // Opportunistically pick up the TP357's broadcast too, whether or not the
    // DHT22 read above succeeded. This is a bonus second sensor, not the
    // primary reading, so a miss here doesn't affect backoff.
    String tp357Label;
    float tp357Temp = NAN;
    float tp357Humidity = NAN;
    if (WiFi.status() == WL_CONNECTED && scanForTP357(tp357Label, tp357Temp, tp357Humidity)) {
      Serial.print("TP357 "); Serial.print(tp357Label);
      Serial.print(": "); Serial.print(tp357Temp); Serial.print(" C, ");
      Serial.print(tp357Humidity); Serial.println(" %");
      // Same sanity check as the DHT22: a garbled advertisement can still
      // decode to numbers, and the Supabase policy would reject them anyway.
      if (isPlausible(tp357Humidity, tp357Temp)) {
        postSupabase(tp357Label, tp357Humidity, tp357Temp, epoch);
      } else {
        Serial.println("Discarding implausible TP357 reading.");
      }
    } else {
      Serial.println("TP357 not seen this cycle.");
    }
  }
}

// --- Helpers ---

void startOTA() {
#ifdef OTA_PASSWORD
  if (otaStarted || WiFi.status() != WL_CONNECTED) return;
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() { Serial.println("OTA update starting..."); });
  ArduinoOTA.onEnd([]() { Serial.println("\nOTA update complete, rebooting."); });
  ArduinoOTA.onProgress([](unsigned int done, unsigned int total) {
    static unsigned int lastPct = 101;
    unsigned int pct = total ? (done * 100U) / total : 0;
    if (pct != lastPct && pct % 10 == 0) {
      Serial.printf("OTA %u%%\n", pct);
      lastPct = pct;
    }
  });
  ArduinoOTA.onError([](ota_error_t error) { Serial.printf("OTA error %u\n", (unsigned)error); });
  ArduinoOTA.begin();
  otaStarted = true;
  Serial.print("OTA ready: ");
  Serial.print(OTA_HOSTNAME);
  Serial.print(".local / ");
  Serial.println(WiFi.localIP());
#endif
}

void handleOTA() {
#ifdef OTA_PASSWORD
  if (!otaStarted) startOTA(); // WiFi wasn't up at boot
  if (otaStarted) ArduinoOTA.handle();
#endif
}

void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  const unsigned long timeoutMs = 15000; // 15s connect window
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" Connected! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(" WiFi connect timeout.");
  }
}

void setupTime() {
  // Configure SNTP with multiple servers
  configTime(0 /* UTC offset */, 0 /* DST */, NTP_SERVERS[0], NTP_SERVERS[1], NTP_SERVERS[2]);
}

bool ensureTimeSync(uint8_t maxAttempts) {
  struct tm timeinfo;
  for (uint8_t i = 0; i < maxAttempts; i++) {
    // getLocalTime() only succeeds once the clock is past 2016, i.e. synced.
    if (getLocalTime(&timeinfo, 100)) return true;
    delay(200);
  }
  return false;
}

bool readDHTStable(float &humidity, float &temperature) {
  for (uint8_t i = 0; i < dhtMaxAttempts; i++) {
    float h = dht.readHumidity();
    float t = dht.readTemperature();
    if (!isnan(h) && !isnan(t)) {
      humidity = h;
      temperature = t;
      return true;
    }
    delay(dhtRetryDelayMs);
  }
  return false;
}

String iso8601UTC(unsigned long epoch) {
  if (epoch < MIN_VALID_EPOCH) return String(""); // clock not synced yet
  time_t raw = (time_t)epoch;
  struct tm *ti = gmtime(&raw);
  if (!ti) return String("");
  char buf[25];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
           ti->tm_year + 1900,
           ti->tm_mon + 1,
           ti->tm_mday,
           ti->tm_hour,
           ti->tm_min,
           ti->tm_sec);
  return String(buf);
}

String hhmmssUTC(unsigned long epoch) {
  if (epoch == 0) return String("");
  time_t raw = (time_t)epoch;
  struct tm *ti = gmtime(&raw);
  if (!ti) return String("");
  char buf[9];
  snprintf(buf, sizeof(buf), "%02d:%02d:%02d", ti->tm_hour, ti->tm_min, ti->tm_sec);
  return String(buf);
}

bool isPlausible(float humidity, float temperature) {
  if (isnan(humidity) || isnan(temperature)) return false;
  if (humidity < 0.0f || humidity > 100.0f) return false;
  if (temperature < -40.0f || temperature > 85.0f) return false; // DHT22 range
  return true;
}

bool postGoogleForms(float humidity, float temperature, unsigned long epoch) {
  HTTPClient http;
  WiFiClientSecure client;
  client.setInsecure(); // For development - in production, use proper certificate validation
  http.begin(client, SERVER_URL);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  http.addHeader("User-Agent", "esp32-dht22-client/1.1");
  http.addHeader("Connection", "close");

  String formData = buildFormPayload(humidity, temperature, epoch);
  int code = http.POST(formData);
  Serial.print("Google Forms HTTP response: ");
  Serial.println(code);
  if (code <= 0) {
    Serial.print("Google Forms HTTP error: ");
    Serial.println(http.errorToString(code));
  }
  http.end();
  return code > 0 && code < 400;
}

bool postSupabase(const String &deviceId, float humidity, float temperature, unsigned long epoch) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY ||
      strlen(SUPABASE_URL) == 0 || strlen(SUPABASE_ANON_KEY) == 0) {
    return false; // not configured; not an error, just a disabled channel
  }

  HTTPClient http;
  WiFiClientSecure client;
  client.setInsecure(); // For development - in production, use proper certificate validation
  String url = String(SUPABASE_URL) + "/rest/v1/readings";
  http.begin(client, url);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Prefer", "return=minimal");

  String payload = buildSupabaseJsonPayload(deviceId, humidity, temperature, epoch);
  int code = http.POST(payload);
  Serial.print("Supabase HTTP response: ");
  Serial.println(code);
  if (code <= 0) {
    Serial.print("Supabase HTTP error: ");
    Serial.println(http.errorToString(code));
  } else if (code >= 400) {
    Serial.print("Supabase error body: ");
    Serial.println(http.getString());
  }
  http.end();
  return code >= 200 && code < 300;
}

String buildFormPayload(float humidity, float temperature, unsigned long epoch) {
  // Google Forms field IDs:
  // Temperature: entry.2135755099
  // Humidity: entry.346799127
  // Device ID: entry.1396898277
  // Timestamp: entry.1586851294
  String out;
  out.reserve(200);
  out = String("entry.2135755099=") + String(temperature, 2) +
        "&entry.346799127=" + String(humidity, 2) +
        "&entry.1396898277=" + WiFi.macAddress() +
        "&entry.1586851294=" + iso8601UTC(epoch);
  return out;
}

String buildSupabaseJsonPayload(const String &deviceId, float humidity, float temperature, unsigned long epoch) {
  // `received_at` is left out on purpose: the table defaults it to the DB's
  // own now() so it reflects when the row actually arrived, independent of
  // this device's clock (anon isn't even granted that column).
  // `device_ts` is left out while the clock is unsynced (empty string from
  // iso8601UTC), since "" isn't a valid timestamptz.
  String deviceTs = iso8601UTC(epoch);
  String out;
#if HAVE_ARDUINOJSON
  {
    StaticJsonDocument<256> doc;
    doc["device_id"] = deviceId;
    doc["temperature"] = roundf(temperature * 100.0f) / 100.0f;
    doc["humidity"] = roundf(humidity * 100.0f) / 100.0f;
    if (deviceTs.length() > 0) doc["device_ts"] = deviceTs;
    serializeJson(doc, out);
  }
#else
  out.reserve(160);
  out = String("{") +
        "\"device_id\": \"" + deviceId + "\"," +
        " \"temperature\": " + String(temperature, 2) +
        ", \"humidity\": " + String(humidity, 2);
  if (deviceTs.length() > 0) out += ", \"device_ts\": \"" + deviceTs + "\"";
  out += "}";
#endif
  return out;
}

bool decodeTP357ManufacturerData(const std::string &data, float &tempC, float &humidityPct) {
  // Byte layout (from thermopro-ble, Bluetooth-Devices org, MIT licensed):
  // data[0..1] is the BLE "manufacturer ID" field, which this device reuses
  // as part of its own payload rather than a real registered company ID.
  // data[1..2] = signed int16 LE, temperature in tenths of a degree C.
  // data[3]    = humidity, as a direct percentage.
  if (data.length() < 6) return false;
  uint8_t b1 = (uint8_t)data[1];
  uint8_t b2 = (uint8_t)data[2];
  uint8_t b3 = (uint8_t)data[3];
  if (b1 == 0xFF && b2 == 0xFF && b3 == 0xFF) return false; // sensor's own "invalid" marker
  int16_t tempRaw = (int16_t)((uint16_t)b1 | ((uint16_t)b2 << 8));
  tempC = tempRaw / 10.0f;
  humidityPct = (float)b3;
  return true;
}

bool scanForTP357(String &label, float &tempC, float &humidityPct) {
  NimBLEScan* bleScan = NimBLEDevice::getScan();
  NimBLEScanResults results = bleScan->getResults(BLE_SCAN_MS, false);
  bool found = false;
  for (int i = 0; i < results.getCount() && !found; i++) {
    const NimBLEAdvertisedDevice* device = results.getDevice(i);
    if (!device->haveName()) continue;
    std::string name = device->getName();
    if (name.rfind(TP357_NAME_PREFIX, 0) != 0) continue; // doesn't start with "TP357"
    if (!device->haveManufacturerData()) continue;
    std::string mfgData = device->getManufacturerData();
    if (decodeTP357ManufacturerData(mfgData, tempC, humidityPct)) {
      label = String(name.c_str());
      found = true;
    }
  }
  bleScan->clearResults();
  return found;
}

unsigned long currentInterval() {
  // compute BASE_INTERVAL_MS * (2^backoffExp) with cap
  unsigned long scaled = BASE_INTERVAL_MS << backoffExp;
  if (scaled < BASE_INTERVAL_MS) scaled = BASE_INTERVAL_MS;
  if (scaled > MAX_BACKOFF_MS) scaled = MAX_BACKOFF_MS;
  return scaled;
}

void onWiFiEvent(WiFiEvent_t event) {
  switch (event) {
#if defined(ARDUINO_EVENT_WIFI_STA_DISCONNECTED)
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
#elif defined(WIFI_EVENT_STA_DISCONNECTED)
    case WIFI_EVENT_STA_DISCONNECTED:
#elif defined(SYSTEM_EVENT_STA_DISCONNECTED)
    case SYSTEM_EVENT_STA_DISCONNECTED:
#endif
      Serial.println("WiFi event: disconnected");
      break;
#if defined(ARDUINO_EVENT_WIFI_STA_CONNECTED)
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
#elif defined(WIFI_EVENT_STA_CONNECTED)
    case WIFI_EVENT_STA_CONNECTED:
#elif defined(SYSTEM_EVENT_STA_CONNECTED)
    case SYSTEM_EVENT_STA_CONNECTED:
#endif
      Serial.println("WiFi event: connected");
      break;
#if defined(ARDUINO_EVENT_WIFI_STA_GOT_IP)
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
#elif defined(IP_EVENT_STA_GOT_IP)
    case IP_EVENT_STA_GOT_IP:
#elif defined(SYSTEM_EVENT_STA_GOT_IP)
    case SYSTEM_EVENT_STA_GOT_IP:
#endif
      Serial.print("WiFi event: got IP ");
      Serial.println(WiFi.localIP());
      break;
    default:
      break;
  }
}
