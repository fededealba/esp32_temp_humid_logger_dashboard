// Core
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include <time.h>
#if __has_include(<ArduinoJson.h>)
#include <ArduinoJson.h>
#define HAVE_ARDUINOJSON 1
#else
#define HAVE_ARDUINOJSON 0
#endif

// Secrets (optionally provided via secrets.h)
#if __has_include("secrets.h")
#include "secrets.h"  // should define WIFI_SSID, WIFI_PASSWORD, optional API_KEY
#else
// Fallbacks (replace or create secrets.h)
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* API_KEY = nullptr;  // optional API key header
#endif

// Google Forms submission URL (HTTPS)
const char* SERVER_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdaHQuuWAcFIjU44oZUqOMrtZhC9smcMoF9IOquQO8FFVwU5Q/formResponse";

// Device metadata
const char* DEVICE_NAME = "esp32-dht22";
const char* FIRMWARE_VERSION = "1.2.0";

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

// DHT read retries
const uint8_t dhtMaxAttempts = 3;
const uint16_t dhtRetryDelayMs = 2000; // DHT22 prefers >=2s between attempts

// Forward declarations
void connectWiFi();
void setupTime();
bool ensureTimeSync(uint8_t maxAttempts = 15);
bool readDHTStable(float &humidity, float &temperature);
String iso8601UTC(unsigned long epoch);
String hhmmssUTC(unsigned long epoch);
bool isPlausible(float humidity, float temperature);
String buildJsonPayload(float humidity, float temperature, unsigned long epoch);
unsigned long currentInterval();
void onWiFiEvent(WiFiEvent_t event);

void setup() {
  Serial.begin(115200);

  connectWiFi();
  WiFi.onEvent(onWiFiEvent);
  WiFi.setAutoReconnect(true);

  setupTime();
  dht.begin();

  // Try to sync time on startup (non-blocking bounded attempts)
  if (!ensureTimeSync()) {
    Serial.println("Warning: NTP time not available yet; will retry later.");
  }

  lastScheduled = millis();
}

void loop() {
  // Keep WiFi alive
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, attempting reconnect...");
    connectWiFi();
  }
  unsigned long currentMillis = millis();

  // Drift-free interval scheduling with rollover safety
  unsigned long intervalMs = currentInterval();
  if ((long)(currentMillis - lastScheduled) >= (long)intervalMs) {
    // If we are extremely behind (e.g., after long block), resync anchor
    if (currentMillis - lastScheduled > 10UL * BASE_INTERVAL_MS) {
      lastScheduled = currentMillis;
    } else {
      lastScheduled = currentMillis; // do not burst-send to catch up
    }

    // Read sensors (with retries)
    float humidity = NAN;
    float temperature = NAN;
    if (!readDHTStable(humidity, temperature)) {
      Serial.println("Failed to read from DHT sensor after retries.");
      return; // skip this cycle
    }

    // Validate plausible ranges
    if (!isPlausible(humidity, temperature)) {
      Serial.println("Discarding implausible sensor reading.");
      return;
    }

    // Prepare timestamps
    time_t now = time(nullptr);
    unsigned long epoch = (unsigned long)now;
    String formattedTime = hhmmssUTC(epoch);     // HH:MM:SS (legacy)
    String timestampIso = iso8601UTC(epoch);     // ISO-8601 Zulu

    // Print to Serial
    Serial.println("Sending data to server...");
    Serial.print("Temp: "); Serial.print(temperature);
    Serial.print(" °C  |  Humidity: "); Serial.print(humidity);
    Serial.print(" %  |  Time: "); Serial.print(formattedTime);
    Serial.print(" | ISO: "); Serial.println(timestampIso);
    Serial.print("Server URL: "); Serial.println(SERVER_URL);
    Serial.print("Device IP: "); Serial.println(WiFi.localIP());

    // Send HTTPS POST
    if (WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      WiFiClientSecure client;
      client.setInsecure(); // For development - in production, use proper certificate validation
      http.begin(client, SERVER_URL);
      http.setTimeout(HTTP_TIMEOUT_MS);
      http.addHeader("Content-Type", "application/x-www-form-urlencoded");
      http.addHeader("User-Agent", "esp32-dht22-client/1.1");
      http.addHeader("Connection", "close");

      // Build form-encoded payload for Google Forms
      String formData = buildFormPayload(humidity, temperature, epoch);

      int httpResponseCode = http.POST(formData);
      Serial.print("HTTP Response: ");
      Serial.println(httpResponseCode);
      if (httpResponseCode <= 0) {
        Serial.print("HTTP error: ");
        Serial.println(http.errorToString(httpResponseCode));
      }
      // Backoff handling: success resets, failure increases
      if (httpResponseCode > 0 && httpResponseCode < 400) {
        backoffExp = 0; // success
      } else {
        if (backoffExp < 6) backoffExp++; // up to 2^6 = 64x
      }
      http.end();
    }
  }
}

// --- Helpers ---

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
    if (gettimeofday(nullptr, nullptr) == 0 && getLocalTime(&timeinfo, 100)) {
      // time is set
      return true;
    }
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
  if (epoch == 0) return String("");
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

String buildJsonPayload(float humidity, float temperature, unsigned long epoch) {
  String out;
#if HAVE_ARDUINOJSON
  {
    StaticJsonDocument<256> doc;
    doc["device"] = WiFi.macAddress();
    doc["name"] = DEVICE_NAME;
    doc["fw"] = FIRMWARE_VERSION;
    doc["temperature"] = roundf(temperature * 100.0f) / 100.0f;
    doc["humidity"] = roundf(humidity * 100.0f) / 100.0f;
    doc["time"] = hhmmssUTC(epoch);
    doc["timestamp"] = iso8601UTC(epoch);
    doc["epoch"] = epoch;
    serializeJson(doc, out);
  }
#else
  out.reserve(160);
  out = String("{") +
        "\"device\": \"" + WiFi.macAddress() + "\"," +
        " \"name\": \"" + DEVICE_NAME + "\"," +
        " \"fw\": \"" + FIRMWARE_VERSION + "\"," +
        " \"temperature\": " + String(temperature, 2) +
        ", \"humidity\": " + String(humidity, 2) +
        ", \"time\": \"" + hhmmssUTC(epoch) + "\"," +
        " \"timestamp\": \"" + iso8601UTC(epoch) + "\"," +
        " \"epoch\": " + String(epoch) +
        "}";
#endif
  return out;
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
