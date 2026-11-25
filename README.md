ESP32 Temp/Humidity Logger Dashboard
====================================

Overview
--------

An ESP32 reads a DHT22 temperature/humidity sensor every minute, and also
picks up the broadcasts of a nearby ThermoPro TP357 Bluetooth sensor. Both
readings go straight into a Supabase (Postgres) table, which a Next.js
dashboard on Vercel reads. A GitHub Actions job sends a Telegram message when
the station goes quiet.

- `firmware/`: ESP32 Arduino sketch. Posts each reading to Supabase over
  HTTPS with the insert-only anon key, and accepts password-protected
  over-the-air updates.
- `dashboard-web/`: Next.js app, deployed to Vercel. Server-side API routes
  read Supabase (and, optionally, Open-Meteo); the page renders the charts.
- `scripts/`: the Supabase schema, the Telegram stale-check, and the firmware
  build wrapper.

Until November 2026 the firmware also sent every reading to a Google Sheet
through Google Forms, which the dashboard could fall back to. The history
from before Supabase was added (July 2026) was backfilled from that sheet,
and the Google path has since been retired; the sheet is no longer written.

Data Flow
---------

1. Every 60 s the ESP32 reads the DHT22 and scans ~5 s for the TP357.
2. Each reading is inserted into Supabase's `readings` table. The database
   stamps `received_at` on arrival; the device adds `device_ts` once its
   clock has synced over NTP.
3. The dashboard's `/api/readings` route queries Supabase with the
   `service_role` key, downsampled server-side for long ranges.
4. `scripts/check-stale.mjs` runs every 5 minutes on GitHub Actions and
   messages Telegram when readings stop arriving, and again on recovery.

Setup
-----

### 1. Supabase

- Create a project at supabase.com.
- Open the SQL Editor and run `scripts/supabase-schema.sql`. It creates the
  `readings` and `alert_state` tables, the insert policy, and the
  downsampling function, and is safe to re-run whenever it changes.
- Copy the project URL and both API keys (Project Settings → API): the
  `anon`/publishable key and the `service_role` key.

The two keys sit on opposite sides of a trust boundary. The anon key lives in
the firmware binary on a physical device you don't fully control, and its
TLS connection isn't certificate-validated (`client.setInsecure()`), so the
schema limits it to inserting plausible readings into four columns of
`readings`: a leaked anon key can add fake rows but can't read, change, or
delete anything, or forge the arrival time. The `service_role` key bypasses
row-level security entirely, so it belongs only in server-side environments
(Vercel, GitHub Actions secrets, your local `.env.local`) and never in
`secrets.h`. If a firmware build was ever flashed with the `service_role`
key, rotate it in Supabase.

### 2. Firmware

Create `firmware/temp_hum_complete/secrets.h` from the example:

```sh
cp firmware/temp_hum_complete/secrets.example.h firmware/temp_hum_complete/secrets.h
```

Then fill it in:

```cpp
#pragma once

const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASSWORD = "your-wifi-password";

// Required. The anon/publishable key, never service_role.
const char* SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co";
const char* SUPABASE_ANON_KEY = "your-anon-key";

// Optional: enables over-the-air updates (see "Updating over WiFi" below).
// Leave it out to disable OTA. Generate one with: openssl rand -hex 16
#define OTA_PASSWORD "a-long-random-password"
```

Then install the toolchain and flash over USB (see "Firmware Workflow" for
details):

```sh
make firmware-setup
PORT=/dev/ttyUSB0 make firmware-upload
```

### 3. Dashboard

Locally (Node.js 20.9 or newer; Vercel builds use Node 22.x via the
`package.json` `engines` field):

```sh
cd dashboard-web
cp .env.example .env.local   # then set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
npm install
npm run dev
```

Open <http://localhost:3000>.

On Vercel: create a project from this repository, set its **Root Directory**
to `dashboard-web` (Settings → Build & Deployment), and add the environment
variables from "Configuration" below. Every push to `main` deploys.

### 4. Telegram alert when the ESP32 goes quiet

`.github/workflows/stale-check.yml` runs `scripts/check-stale.mjs` every 5
minutes (free at any frequency on a public repo; on a private one it would
eat into the 2,000 free minutes/month). It compares the newest reading's
`received_at` against the same 5-minute threshold the dashboard uses, and
messages a Telegram bot on the transition into or out of that state, not on
every run, so a long outage doesn't spam repeated alerts.

- Message **@BotFather** on Telegram, run `/newbot`, and copy the token.
- Send your new bot any message, then fetch
  `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat_id`.
- Add four repository secrets (Settings → Secrets and variables → Actions):
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (same values as Vercel),
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Trigger a manual run from the Actions tab (or `gh workflow run stale-check.yml`)
to test it without waiting for the schedule.

GitHub disables scheduled workflows after 60 days without repository
activity, silently. To prevent that, each run re-enables its own workflow,
which resets the timer. Each run also records a heartbeat
(`alert_state.last_checked_at`), and the dashboard shows a warning banner if
the check hasn't run for 6 hours, so a stopped schedule doesn't go
unnoticed.

Firmware Workflow
-----------------

The repo includes a small Arduino CLI wrapper and VS Code tasks for firmware
development. `make firmware-setup` installs `arduino-cli` into `.tools/bin` if
it is missing, then installs the ESP32 core and sketch libraries.

```sh
make firmware-setup          # toolchain + libraries
make firmware-install-cli    # only the CLI
make firmware-compile
make firmware-ports          # list connected boards and ports
PORT=/dev/ttyUSB0 make firmware-upload
PORT=/dev/ttyUSB0 make firmware-monitor
```

Uploads use `UPLOAD_SPEED=115200` by default for reliability; override it if
your board and cable are stable at a higher speed
(`PORT=/dev/ttyUSB0 UPLOAD_SPEED=460800 make firmware-upload`). The monitor
leaves `DTR` and `RTS` off so the board isn't held in reset by the terminal.

If the board doesn't show up as `/dev/ttyUSB*` or `/dev/ttyACM*`, try another
cable (many only carry power). If it shows up but uploads fail with
"permission denied", add yourself to the `dialout` group
(`sudo usermod -aG dialout $USER`) and log in again.

### Updating over WiFi

When `OTA_PASSWORD` is defined in `secrets.h`, the firmware listens for
password-protected updates on your LAN as `esp32-weather.local`. After one
USB flash of an OTA-enabled build, later updates need no cable:

```sh
make firmware-upload-ota
OTA_HOST=192.168.1.50 make firmware-upload-ota   # if .local names don't resolve
```

The password is read from `secrets.h`, so the upload always matches what the
device was built with. The ESP32 prints its IP on the serial monitor at boot
(`OTA ready: ...`). It only checks for uploads between phases of its 60s
sensor cycle, so an attempt that lands mid-cycle can time out: just rerun it.
If an upload fails partway, the device keeps running the old firmware.

### Board and partition scheme

The default board FQBN is `esp32:esp32:esp32`, compiled with
`PartitionScheme=min_spiffs`: two 1.9MB app slots, so an OTA update can be
written into the inactive slot while the current firmware runs. The default
scheme's 1.2MB slots are too small (NimBLE-Arduino alone used most of one).
Changing the partition scheme rewrites the flash layout, which only a USB
upload can do; builds before OTA support used `huge_app`, so the first
flash after it must be over USB. Override `PARTITION_SCHEME` or `FQBN` if
your board needs a different profile:

```sh
FQBN=esp32:esp32:esp32doit-devkit-v1 make firmware-compile
PORT=/dev/ttyUSB0 FQBN=esp32:esp32:esp32doit-devkit-v1 make firmware-upload
```

You can also run the wrapper directly (`scripts/firmware.sh help`), or in VS
Code run `Tasks: Run Task` and pick one of the `Firmware: ...` tasks.

Vercel Dashboard
----------------

Paths below are relative to `dashboard-web/`.

- `app/page.tsx`: the page: data fetching, controls, banners, and layout.
- `components/`: `MetricChart` (temperature/humidity trends), `ScatterChart`
  (temperature vs humidity, animated), `StatusCard`, and the Plotly loader
  (lazy-loads `plotly.js-basic-dist-min` on the client).
- `app/api/readings/route.ts` and `lib/db.ts`: Supabase REST (PostgREST)
  loading, windowing, and server-side downsampling.
- `app/api/weather/route.ts`, `app/api/weather/history/route.ts`, and
  `lib/weather.ts`: optional Open-Meteo "official" current reading and up to
  93 days of hourly history, fetched live in one call and cached for several
  minutes.
- `lib/`: the shared response types, plus the pure calculations behind the
  page (heat index, dew point, trends, chart gap detection, staleness,
  timezone formatting), each unit-tested (`npm test`).
- `plotly.d.ts`: type shim mapping `plotly.js-basic-dist-min` to `plotly.js` types.

The dashboard includes:

- Device, time range, timezone, Celsius/Fahrenheit, and auto-refresh controls.
- A status card per device: temperature, heat index, humidity, dew point,
  absolute humidity, and 10-minute trend arrows.
- Temperature and humidity charts that share one zoomable, pannable time axis,
  break the line across outages, and keep their zoom through auto-refresh.
- A temperature-vs-humidity scatter chart with a playable time animation.
- A recent readings table.
- An offline banner when the newest reading for the selected device is more
  than 5 minutes old, even when the outage is longer than the selected range.
- A banner when the Telegram stale-check itself hasn't run for 6 hours.
- Optional "official" outdoor temperature/humidity from Open-Meteo, shown next
  to each device's reading with the delta between them, and overlaid on the
  charts as a dotted reference line.

Configuration
-------------

Dashboard environment variables (Vercel project settings, or
`dashboard-web/.env.local`):

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (required).
- `NEXT_PUBLIC_DASHBOARD_TIMEZONE`: default display timezone, for example
  `Europe/Paris`.
- `OPEN_METEO_LATITUDE` and `OPEN_METEO_LONGITUDE` (optional): enable the
  Open-Meteo comparison. Server-only; the coordinates never reach the
  browser.

Firmware constants (`firmware/temp_hum_complete/temp_hum_complete.ino`):

- `DHTPIN` and `DHTTYPE`: sensor configuration (GPIO 4, DHT22).
- `BASE_INTERVAL_MS`: post interval (60 s), backed off exponentially up to
  10 minutes while Supabase is unreachable.
- `TP357_NAME_PREFIX`: Bluetooth name prefix used to find the TP357.
- `OTA_HOSTNAME`: the network name for over-the-air updates.
- In `secrets.h`: `WIFI_SSID`, `WIFI_PASSWORD`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, and optionally `OTA_PASSWORD`.

The `readings` table (`scripts/supabase-schema.sql`) has `id`, `device_id`,
`temperature`, `humidity`, `device_ts` (the device's clock, null until NTP
syncs), and `received_at` (the database's clock, used for staleness).

Troubleshooting
---------------

- **Dashboard shows "Supabase is not configured"**: set `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` or the Vercel settings.
- **"relation does not exist" (404) from Supabase**: run
  `scripts/supabase-schema.sql` in the SQL Editor.
- **No new readings**: open the serial monitor. `Supabase HTTP response: 201`
  means rows are landing; a 401/403 means the anon key is wrong or the row
  was rejected by the insert policy (for example, an out-of-range value);
  "Supabase not configured" means `secrets.h` is missing the URL or key.
- **Wrong displayed time**: pick the timezone in the dashboard, or set
  `NEXT_PUBLIC_DASHBOARD_TIMEZONE`.

Notes
-----

- `firmware/**/secrets.h` and `dashboard-web/.env.local` are ignored by Git.
- `credentials.json` files (Google service account keys from the retired
  Sheets integration) stay ignored so a leftover key can never be committed.
