ESP32 Temp/Humidity Logger Dashboard
====================================

Overview
--------

- firmware/: ESP32 sketch for DHT22, posts JSON to Flask.
- server/: Flask API + SQLite storage for readings.
- dashboard/: Streamlit app consuming the API for charts.

Quick Start
-----------

1) Start the Flask server

- Create a venv and install deps:
  - cd server
  - python -m venv .venv && source .venv/bin/activate
  - pip install -r requirements.txt
- Optional: set API key
  - export INGEST_API_KEY="your-key"
- Run the server (creates DB under server/instance/):
  - python app.py
- Health check: http://localhost:5001/health

2) Configure and flash the ESP32

- Edit firmware/esp32_dht22/secrets.h with Wi‑Fi/AP key if used.
- In temp_hum_complete.ino, set SERVER_URL to your machine IP, e.g.:
  - http://<your-lan-ip>:5001/data
- Build/flash via Arduino IDE or PlatformIO.

3) Run the dashboard

- Create a venv and install deps:
  - cd dashboard
  - python -m venv .venv && source .venv/bin/activate
  - pip install -r requirements.txt
- Point to the server URL (optional, defaults to http://localhost:5001):
  - export API_BASE_URL="http://<your-lan-ip>:5001"
  - If server uses key: export DASHBOARD_API_KEY="your-key"
- Start Streamlit:
  - streamlit run app.py

Dashboard Features
------------------

- Filters: device selector, time presets (Last hour/12h/24h/Week), custom date & time range.
- Units: Celsius/Fahrenheit toggle; gauges and charts reflect the selection.
- Combined chart: temperature (left axis) + humidity (right axis) over time.
- Status & refresh: server online indicator, auto-refresh with configurable interval, row cap.

Configuration
-------------

- Dashboard environment variables:
  - `API_BASE_URL` — base URL of the Flask API (default `http://localhost:5001`).
  - `DASHBOARD_API_KEY` — set if the server requires an API key.
- Server environment variables:
  - `INGEST_API_KEY` — require this key via `X-Api-Key` header on `/data`.

API Endpoints (server)
----------------------

- GET /health — health check
- POST /data — ingest readings (JSON: temperature, humidity, optional metadata)
- GET /data — paginated list (query: page, per_page, device_id, from, to)
- GET /check — DB info
- GET /log — all rows (for debugging)

Notes
-----

- DB path: server/instance/weather_data.db (auto-created).
- Dashboard consumes the API; it does not read the DB file.
- Secrets: firmware/**/secrets.h is git-ignored.
