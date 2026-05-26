ESP32 Temp/Humidity Logger Dashboard
====================================

Overview
--------

This branch uses Google Forms and Google Sheets for ingestion and storage.

- `firmware/`: ESP32 Arduino sketch for a DHT22 sensor. It submits
  temperature, humidity, device ID, and timestamp values to a Google Form.
- `dashboard-web/`: Next.js app and Vercel deployment target. It reads the
  linked Google Sheet through a serverless API route and renders the dashboard
  in React.
- `dashboard/`: Streamlit dashboard. It reads the linked Google Sheet with
  Google service account credentials and renders metrics, charts, and raw data.

No local Flask server or SQLite database is required for the current flow.

Data Flow
---------

1. The ESP32 reads the DHT22 sensor.
2. The firmware posts form-encoded readings to Google Forms.
3. Google Forms appends each response to a linked Google Sheet.
4. The Next.js or Streamlit dashboard reads the Google Sheet and displays the
   data.

Quick Start
-----------

0) Activate your Python environment

```sh
conda activate py313
```

1) Configure Google Forms and Google Sheets

The repository currently contains a Google Form URL in
`firmware/temp_hum_complete/temp_hum_complete.ino` and a Google Sheet ID in
`dashboard/app.py`.

If you are using your own Google Form:

- Create short-answer fields for temperature, humidity, device ID, and device
  timestamp.
- Link the form responses to a Google Sheet.
- Update `SERVER_URL` in `firmware/temp_hum_complete/temp_hum_complete.ino`.
- Update the `entry.*` field IDs in `buildFormPayload(...)`.
- Update `GOOGLE_SHEETS_ID` in `dashboard/app.py`.

2) Configure Google Sheets credentials

The dashboard needs read access to the response sheet.

- Create a Google Cloud service account.
- Enable the Google Sheets API for the project.
- Share the Google Sheet with the service account email address.
- Provide credentials with one of these options:

```sh
export GOOGLE_CREDENTIALS_FILE="/absolute/path/to/service-account.json"
```

or:

```sh
export GOOGLE_CREDENTIALS_JSON='{"type":"service_account", "...":"..."}'
```

If you run Streamlit from the `dashboard/` directory, you can also place the
service account JSON at `dashboard/credentials.json`. That file is ignored by
Git.

There is a placeholder example at `dashboard/credentials.example.json`, but the
real `dashboard/credentials.json` should be the full JSON key downloaded from
Google Cloud:

```sh
cp dashboard/credentials.example.json dashboard/credentials.json
```

Replace the placeholder values, or more commonly replace the copied file with
the downloaded service account key JSON.

3) Run the Vercel dashboard locally

Install Node.js 20.9.0 or newer (Vercel builds are pinned to Node 22.x via the
`package.json` `engines` field), then from the `dashboard-web/` directory:

```sh
cd dashboard-web
cp .env.example .env.local
npm install
npm run dev
```

For local development, the Next.js API can also read the ignored
`dashboard/credentials.json` file directly, so you do not need to paste
`GOOGLE_CREDENTIALS_JSON` into `.env.local` if that file exists. If you do use
`GOOGLE_CREDENTIALS_JSON`, uncomment it in `.env.local` and replace the
placeholder with the full service account key JSON.

Open <http://localhost:3000>.

4) Deploy the Vercel dashboard

Create a Vercel project from this repository. Set the project **Root Directory**
to `dashboard-web` (Settings -> Build & Deployment), then set these environment
variables in the Vercel project settings:

- `GOOGLE_SHEETS_ID`: the linked response spreadsheet ID.
- `GOOGLE_CREDENTIALS_JSON`: the full service account key JSON.
- `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`: optional alternative to
  `GOOGLE_CREDENTIALS_JSON`.
- `NEXT_PUBLIC_DASHBOARD_TIMEZONE`: optional default timezone, for example
  `Europe/Paris`.

Do not upload `dashboard/credentials.json` to Vercel or commit it to Git. The
service account email in the JSON must be shared on the Google Sheet as a
Viewer.

5) Run the Streamlit dashboard locally

```sh
cd dashboard
pip install -r requirements.txt
streamlit run app.py
```

Optional timezone override:

```sh
export DASHBOARD_TIMEZONE="Europe/Paris"
```

The dashboard also includes a timezone selector in the sidebar.

6) Configure and flash the ESP32

Create `firmware/temp_hum_complete/secrets.h` from the example:

```sh
cp firmware/temp_hum_complete/secrets.example.h firmware/temp_hum_complete/secrets.h
```

Then edit `firmware/temp_hum_complete/secrets.h`:

```cpp
#pragma once

const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASSWORD = "your-wifi-password";
```

Then verify the firmware settings in
`firmware/temp_hum_complete/temp_hum_complete.ino`:

- `SERVER_URL`: Google Forms `formResponse` URL.
- `buildFormPayload(...)`: Google Forms field IDs.
- `DHTPIN`: sensor data pin, currently GPIO 4.
- `BASE_INTERVAL_MS`: post interval, currently 60 seconds.

Build and flash from VS Code with the Arduino CLI workflow below, or use the
Arduino IDE if you prefer.

Firmware Workflow
-----------------

The repo includes a small Arduino CLI wrapper and VS Code tasks for firmware
development. `make firmware-setup` installs `arduino-cli` into `.tools/bin` if
it is missing, then installs the ESP32 core and sketch libraries.

```sh
make firmware-setup
```

To install only the CLI:

```sh
make firmware-install-cli
```

Compile:

```sh
make firmware-compile
```

List connected boards and ports:

```sh
make firmware-ports
```

Upload, replacing the port with the one from `firmware-ports`:

```sh
PORT=/dev/ttyUSB0 make firmware-upload
```

Uploads use `UPLOAD_SPEED=115200` by default for reliability. You can override
it if your board and cable are stable at a higher speed:

```sh
PORT=/dev/ttyUSB0 UPLOAD_SPEED=460800 make firmware-upload
```

Open the serial monitor:

```sh
PORT=/dev/ttyUSB0 make firmware-monitor
```

The monitor leaves `DTR` and `RTS` off so ESP32 boards are not held in reset by
the serial terminal.

The default board FQBN is `esp32:esp32:esp32`. Override it if your board needs a
more specific profile:

```sh
FQBN=esp32:esp32:esp32doit-devkit-v1 make firmware-compile
PORT=/dev/ttyUSB0 FQBN=esp32:esp32:esp32doit-devkit-v1 make firmware-upload
```

You can also run the wrapper directly:

```sh
scripts/firmware.sh help
```

In VS Code, open the command palette and run `Tasks: Run Task`, then choose one
of the `Firmware: ...` tasks.

Vercel Dashboard
----------------

The `dashboard-web/` Next.js app is the Vercel deployment target (paths below
are relative to `dashboard-web/`).

- `app/page.tsx`: dashboard UI, including the interactive Plotly trend chart
  (lazy-loads `plotly.js-basic-dist-min` on the client).
- `app/api/readings/route.ts`: Vercel serverless API route.
- `lib/sheets.ts`: Google Sheets authentication, loading, and normalization.
- `plotly.d.ts`: type shim mapping `plotly.js-basic-dist-min` to `plotly.js` types.
- `.env.example`: local and Vercel environment variable template.

The Vercel dashboard includes:

- Device, time range, timezone, Celsius/Fahrenheit, and auto-refresh controls.
- Current and average temperature and humidity metrics.
- Interactive Plotly trend with separate temperature and humidity panels that
  share one zoomable, pannable time axis (zooming the x-axis moves both). Hover
  tooltips, auto-fitting humidity scale, and a zoom that survives auto-refresh.
- Recent readings table.
- Server-side Google Sheets access, so service account credentials are not
  exposed to the browser.

The API route supports the current Google Forms response sheet shape:

- First timestamp column: Google Forms submission timestamp.
- Temperature column: Celsius.
- Humidity column: percent.
- Device column: ESP32 MAC address.
- Later timestamp column: device-generated ISO-8601 timestamp.

Streamlit Dashboard Features
----------------------------

- Google Sheets connection status.
- Device filter based on the device IDs in the sheet.
- Time range presets: last hour, last 12 hours, last 24 hours, last week, and
  all data.
- Timezone selection.
- Celsius/Fahrenheit toggle.
- Current temperature and humidity metrics with gauges.
- Dual-axis temperature and humidity trend chart.
- Loaded-record count, averages, and earliest loaded date.
- Raw data table with CSV download.
- Optional auto-refresh with configurable interval.

Configuration
-------------

Vercel dashboard environment variables:

- `GOOGLE_SHEETS_ID`: response sheet ID.
- `GOOGLE_CREDENTIALS_JSON`: service account JSON content.
- `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`: optional alternative to
  `GOOGLE_CREDENTIALS_JSON`.
- `GOOGLE_CREDENTIALS_FILE`: local-only path to a Google service account JSON
  file.
- `NEXT_PUBLIC_DASHBOARD_TIMEZONE`: default timezone used by the React
  dashboard.

Streamlit dashboard environment variables:

- `GOOGLE_CREDENTIALS_FILE`: path to a Google service account JSON file.
- `GOOGLE_CREDENTIALS_JSON`: service account JSON content.
- `DASHBOARD_TIMEZONE`: default timezone used before a sidebar selection.

Dashboard code constants:

- `GOOGLE_SHEETS_ID` in `dashboard/app.py`: response sheet ID.
- `CREDENTIALS_FILE` in `dashboard/app.py`: defaults to
  `dashboard/credentials.json`.

Firmware constants:

- `SERVER_URL`: Google Forms submission endpoint.
- `DEVICE_NAME` and `FIRMWARE_VERSION`: metadata used in generated payloads.
- `DHTPIN` and `DHTTYPE`: sensor configuration.
- Google Forms `entry.*` IDs in `buildFormPayload(...)`.

The previous Flask settings `API_BASE_URL`, `DASHBOARD_API_KEY`, and
`INGEST_API_KEY` are not used by the current Google Forms/Sheets flow.

Expected Sheet Columns
----------------------

The dashboard maps columns by name and position. It expects values equivalent
to:

- First `Timestamp`: Google Forms submission timestamp.
- `Temperature`: numeric temperature in Celsius.
- `Humidity`: numeric relative humidity percentage.
- `Device ID`: ESP32 identifier, currently the Wi-Fi MAC address.
- Later `Timestamp`: device-generated ISO-8601 timestamp.

Troubleshooting
---------------

- `Google credentials not found`: set `GOOGLE_CREDENTIALS_FILE`, set
  `GOOGLE_CREDENTIALS_JSON`, or place `credentials.json` in `dashboard/`.
- Google Sheets connection error: confirm the Sheets API is enabled, the sheet
  is shared with the service account email, and `GOOGLE_SHEETS_ID` is correct.
- No dashboard data: confirm the ESP32 receives a successful HTTP response from
  Google Forms and that the `entry.*` IDs match your form fields.
- Wrong displayed time: select the correct timezone in the sidebar or set
  `DASHBOARD_TIMEZONE`.

Notes
-----

- `firmware/**/secrets.h` is ignored by Git.
- `dashboard/credentials.json` and root `credentials.json` are ignored by Git.
- The dashboard reads Google Sheets directly; it does not read a local database.
