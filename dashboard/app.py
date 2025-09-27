import os
import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import requests
from datetime import datetime, timedelta, date, time as dtime, timezone
import time
from zoneinfo import ZoneInfo
from pandas.api.types import is_datetime64tz_dtype

# Set page config
st.set_page_config(
    page_title="ESP32 Weather Monitor",
    page_icon="🌡️",
    layout="wide"
)

# Add title and description
st.title("ESP32 Weather Station Dashboard")
st.markdown("Real-time temperature and humidity monitoring from ESP32 sensor data")

# Function to load data from SQLite database
def _api_base_url():
    """Resolve API base URL from env or default Google Cloud Run."""
    return os.environ.get("API_BASE_URL", "https://esp32-weather-api-rfzelnqpha-uc.a.run.app")


def _api_headers():
    headers = {"Accept": "application/json"}
    api_key = os.environ.get("DASHBOARD_API_KEY")
    if api_key:
        headers["X-Api-Key"] = api_key
    return headers


def _local_timezone():
    tz_name = os.environ.get("DASHBOARD_TIMEZONE")
    if tz_name:
        try:
            return ZoneInfo(tz_name)
        except Exception:
            st.warning(f"Invalid DASHBOARD_TIMEZONE '{tz_name}', falling back to system timezone")
    try:
        tz = datetime.now().astimezone().tzinfo
        return tz or timezone.utc
    except Exception:
        return timezone.utc


def _to_utc(dt: datetime | None, local_tz) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=local_tz)
    return dt.astimezone(timezone.utc)


@st.cache_data(ttl=10)
def load_data(max_rows: int = 2000, device_id: str | None = None, start: datetime | None = None, end: datetime | None = None):
    """Fetch data from Flask API, applying optional filters.
    - max_rows: maximum rows to retrieve across pages
    - device_id: optional device filter
    - start/end: datetime range (compared to server-side received_at)
    """
    base = _api_base_url().rstrip("/")
    headers = _api_headers()
    per_page = 500  # API max
    page = 1
    rows = []
    try:
        while len(rows) < max_rows:
            params = {"page": page, "per_page": per_page}
            if device_id:
                params["device_id"] = device_id
            # Server expects 'YYYY-MM-DD HH:MM:SS'
            if start is not None:
                params["from"] = start.strftime('%Y-%m-%d %H:%M:%S')
            if end is not None:
                params["to"] = end.strftime('%Y-%m-%d %H:%M:%S')
            resp = requests.get(f"{base}/data", params=params, headers=headers, timeout=5)
            resp.raise_for_status()
            payload = resp.json()
            items = payload.get("data", [])
            if not items:
                break
            rows.extend(items)
            if page >= payload.get("pages", 1):
                break
            page += 1
        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows)
        # Parse timestamps and create unified 'ts'
        if 'received_at' in df.columns:
            df['received_at'] = pd.to_datetime(df['received_at'], errors='coerce', utc=True)
        if 'device_timestamp' in df.columns:
            df['device_timestamp'] = pd.to_datetime(df['device_timestamp'], errors='coerce', utc=True)
        df['ts'] = df['device_timestamp'].where(df.get('device_timestamp').notna(), df.get('received_at'))
        local_tz = _local_timezone()
        if 'ts' in df.columns:
            if is_datetime64tz_dtype(df['ts']):
                df['ts'] = df['ts'].dt.tz_convert('UTC')
            else:
                df['ts'] = df['ts'].dt.tz_localize('UTC')
            if local_tz:
                try:
                    df['display_ts'] = df['ts'].dt.tz_convert(local_tz)
                except Exception:
                    df['display_ts'] = df['ts']
            df['ts_utc'] = df['ts']
        return df.sort_values(by='id', ascending=False).reset_index(drop=True)
    except Exception as e:
        st.error(f"Error loading data from API: {e}")
        return pd.DataFrame()


@st.cache_data(ttl=30)
def load_devices(sample_pages: int = 3):
    """Load a set of distinct devices from the newest few pages."""
    base = _api_base_url().rstrip("/")
    headers = _api_headers()
    devices = {}
    try:
        for page in range(1, sample_pages + 1):
            resp = requests.get(f"{base}/data", params={"page": page, "per_page": 500}, headers=headers, timeout=5)
            resp.raise_for_status()
            payload = resp.json()
            for r in payload.get("data", []):
                did = r.get('device_id') or r.get('device')
                if not did:
                    continue
                devices[did] = {
                    'device_id': did,
                    'device_name': r.get('device_name'),
                    'fw': r.get('fw'),
                }
            if page >= payload.get("pages", 1):
                break
    except Exception:
        pass
    return list(devices.values())


@st.cache_data(ttl=5)
def server_health():
    base = _api_base_url().rstrip("/")
    headers = _api_headers()
    try:
        resp = requests.get(f"{base}/health", headers=headers, timeout=3)
        return resp.ok
    except Exception:
        return False

# Sidebar controls
st.sidebar.title("Settings")
st.sidebar.write(f"API: {_api_base_url()}")

local_tz = _local_timezone()
tz_label = getattr(local_tz, 'key', str(local_tz)) if local_tz else 'UTC'
st.sidebar.write(f"Timezone: {tz_label}")

# Status and refresh
health_ok = server_health()
st.sidebar.write("Server:", "✅ Online" if health_ok else "❌ Offline")

max_rows = st.sidebar.slider("Max rows", 500, 20000, 4000, step=500)

auto_refresh = st.sidebar.checkbox("Auto-refresh data", value=True)
refresh_interval = st.sidebar.slider("Refresh interval (seconds)", 5, 60, 10)

# Device filter
devices = load_devices()
device_options = ["All devices"] + [d['device_id'] for d in devices]
selected_device = st.sidebar.selectbox("Device", device_options)
device_id = None if selected_device == "All devices" else selected_device

# Time range
time_preset = st.sidebar.selectbox("Time Range", ["Last Hour", "Last 12 Hours", "Last 24 Hours", "Last Week", "Custom", "All Data"], index=2)
start_dt = end_dt = None
now = datetime.now()
if time_preset == "Custom":
    col_a, col_b = st.sidebar.columns(2)
    with col_a:
        d_from: date = st.date_input("From date", value=now.date())
        t_from: dtime = st.time_input("From time", value=dtime(0, 0))
    with col_b:
        d_to: date = st.date_input("To date", value=now.date(), key="to_date")
        t_to: dtime = st.time_input("To time", value=now.time().replace(microsecond=0), key="to_time")
    start_dt = datetime.combine(d_from, t_from)
    end_dt = datetime.combine(d_to, t_to)
elif time_preset != "All Data":
    hours_dict = {"Last Hour": 1, "Last 12 Hours": 12, "Last 24 Hours": 24, "Last Week": 168}
    start_dt = now - timedelta(hours=hours_dict[time_preset])
    end_dt = None

# Units toggle
use_f = st.sidebar.toggle("Show Fahrenheit", value=False)

# Load the data with filters
start_utc = _to_utc(start_dt, local_tz) if start_dt else None
end_utc = _to_utc(end_dt, local_tz) if end_dt else None

df = load_data(max_rows=max_rows, device_id=device_id, start=start_utc, end=end_utc)

# Check if data is available
if df.empty:
    st.warning("No data available in the database. Make sure your ESP32 is sending data to the Flask server.")
else:
    # Create dashboard layout
    col1, col2 = st.columns(2)
    
    # Current readings in the first column
    with col1:
        st.subheader("Current Readings")
        latest = df.iloc[0]
        
        # Current temperature with gauge
        current_temp_c = float(latest['temperature'])
        current_temp = (current_temp_c * 9/5 + 32) if use_f else current_temp_c
        delta_temp = None
        if len(df) > 1:
            prev_c = float(df.iloc[1]['temperature'])
            delta_temp_val = ((current_temp_c - prev_c) * 9/5) if use_f else (current_temp_c - prev_c)
            delta_temp = f"{delta_temp_val:.1f}{'°F' if use_f else '°C'}"
        st.metric("Temperature", f"{current_temp:.1f}{'°F' if use_f else '°C'}", delta_temp)
        
        # Temperature gauge respects unit toggle
        temp_min_c, temp_max_c = 10, 40
        if use_f:
            gmin, gmax = temp_min_c * 9/5 + 32, temp_max_c * 9/5 + 32
            steps = [
                {'range': [gmin, 68], 'color': "lightblue"},
                {'range': [68, 86], 'color': "lightyellow"},
                {'range': [86, gmax], 'color': "lightcoral"}
            ]
            title_txt = "Temperature (°F)"
        else:
            gmin, gmax = temp_min_c, temp_max_c
            steps = [
                {'range': [10, 20], 'color': "lightblue"},
                {'range': [20, 30], 'color': "lightyellow"},
                {'range': [30, 40], 'color': "lightcoral"}
            ]
            title_txt = "Temperature (°C)"

        fig_temp_gauge = go.Figure(go.Indicator(
            mode="gauge+number",
            value=current_temp,
            domain={'x': [0, 1], 'y': [0, 1]},
            title={'text': title_txt},
            gauge={
                'axis': {'range': [gmin, gmax]},
                'bar': {'color': "red"},
                'steps': steps
            }
        ))
        st.plotly_chart(fig_temp_gauge, use_container_width=True)
        
        # Current humidity with gauge
        current_hum = latest['humidity']
        st.metric("Humidity", f"{current_hum:.1f}%", 
                 f"{current_hum - df.iloc[1]['humidity']:.1f}%" if len(df) > 1 else None)
        
        fig_hum_gauge = go.Figure(go.Indicator(
            mode="gauge+number",
            value=current_hum,
            domain={'x': [0, 1], 'y': [0, 1]},
            title={'text': "Humidity (%)"},
            gauge={
                'axis': {'range': [0, 100]},
                'bar': {'color': "blue"},
                'steps': [
                    {'range': [0, 30], 'color': "lightyellow"},
                    {'range': [30, 70], 'color': "lightgreen"},
                    {'range': [70, 100], 'color': "lightblue"}
                ]
            }
        ))
        st.plotly_chart(fig_hum_gauge, use_container_width=True)
    
    # Historical data in the second column
    with col2:
        st.subheader("Historical Trends")
        
        # Data is already filtered by API for presets; for custom filters apply local filter too
        filtered_df = df
        if start_utc is not None and 'ts_utc' in df.columns:
            filtered_df = filtered_df[filtered_df['ts_utc'] >= start_utc]
        if end_utc is not None and 'ts_utc' in df.columns:
            filtered_df = filtered_df[filtered_df['ts_utc'] <= end_utc]
            
        # Check if filtered data is available
        if filtered_df.empty:
            st.warning(f"No data available for {time_preset}.")
        else:
            # Combined dual-axis chart
            x_col = 'display_ts' if 'display_ts' in filtered_df.columns else (
                'ts_utc' if 'ts_utc' in filtered_df.columns else (
                    'received_at' if 'received_at' in filtered_df.columns else None))
            if x_col is None:
                st.warning("No time column available to plot.")
            else:
                df_plot = filtered_df.copy()
                if use_f:
                    df_plot['temp_display'] = df_plot['temperature'] * 9/5 + 32
                    t_label = 'Temperature (°F)'
                else:
                    df_plot['temp_display'] = df_plot['temperature']
                    t_label = 'Temperature (°C)'

                fig = go.Figure()
                fig.add_trace(go.Scatter(x=df_plot[x_col], y=df_plot['temp_display'], name=t_label, yaxis='y1', mode='lines'))
                fig.add_trace(go.Scatter(x=df_plot[x_col], y=df_plot['humidity'], name='Humidity (%)', yaxis='y2', mode='lines'))

                fig.update_layout(
                    title='Temperature and Humidity Over Time',
                    xaxis_title='Time',
                    yaxis=dict(title=t_label, side='left', range=[df_plot['temp_display'].min()*0.95, df_plot['temp_display'].max()*1.05]),
                    yaxis2=dict(title='Humidity (%)', overlaying='y', side='right', range=[0, 100]),
                    legend=dict(orientation='h')
                )
                st.plotly_chart(fig, use_container_width=True)
    
    # Data statistics and table
    st.subheader("Data Statistics")
    col_stats1, col_stats2, col_stats3, col_stats4 = st.columns(4)

    with col_stats1:
        st.metric("Total Records (loaded)", f"{len(df)}")

    with col_stats2:
        avg_c = float(df['temperature'].mean()) if not df['temperature'].empty else 0.0
        avg_disp = (avg_c * 9/5 + 32) if use_f else avg_c
        st.metric("Avg Temperature", f"{avg_disp:.1f}{'°F' if use_f else '°C'}")

    with col_stats3:
        st.metric("Avg Humidity", f"{df['humidity'].mean():.1f}%")

    with col_stats4:
        if 'display_ts' in df.columns:
            since = df['display_ts'].min()
        elif 'ts_utc' in df.columns:
            since = df['ts_utc'].min().tz_convert(local_tz) if local_tz else df['ts_utc'].min()
        else:
            since = df['received_at'].min() if 'received_at' in df.columns else None
        st.metric("Data Since", since.strftime('%Y-%m-%d') if pd.notna(since) else 'N/A')
    
    # Raw data table with expand/collapse
    with st.expander("View Raw Data"):
        st.dataframe(df)
        
        # Download button for the data
        csv = df.to_csv(index=False).encode('utf-8')
        st.download_button(
            "Download CSV",
            csv,
            "esp32_weather_data.csv",
            "text/csv",
            key='download-csv'
        )

if auto_refresh:
    st.sidebar.write(f"Dashboard will refresh every {refresh_interval} seconds")
    time.sleep(refresh_interval)
    st.rerun()
