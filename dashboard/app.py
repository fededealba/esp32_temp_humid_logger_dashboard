import os
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import gspread
from google.oauth2.service_account import Credentials

# Set page config
st.set_page_config(
    page_title="ESP32 Weather Monitor",
    page_icon="🌡️",
    layout="wide"
)

# Add title and description
st.title("ESP32 Weather Station Dashboard")
st.markdown("Real-time temperature and humidity monitoring from ESP32 sensor data via Google Sheets")

# Google Sheets configuration
APP_DIR = Path(__file__).resolve().parent
GOOGLE_SHEETS_ID = "1PWeQyc0tR10fEe9v0JoBriOJLLUz-M5jYO3oxx_Z2gI"
CREDENTIALS_FILE = os.environ.get("GOOGLE_CREDENTIALS_FILE", str(APP_DIR / "credentials.json"))

def _local_timezone():
    # Check if user selected a timezone in the sidebar
    if 'selected_timezone' in st.session_state:
        try:
            return ZoneInfo(st.session_state.selected_timezone)
        except Exception:
            pass

    # Check environment variable
    tz_name = os.environ.get("DASHBOARD_TIMEZONE")
    if tz_name:
        try:
            return ZoneInfo(tz_name)
        except Exception:
            st.warning(f"Invalid DASHBOARD_TIMEZONE '{tz_name}', falling back to system timezone")

    # Auto-detect system timezone
    try:
        tz = datetime.now().astimezone().tzinfo
        return tz or timezone.utc
    except Exception:
        return timezone.utc

def _get_gspread_client():
    """Initialize gspread client with service account credentials."""
    try:
        # Try to load credentials from file
        if os.path.exists(CREDENTIALS_FILE):
            try:
                creds = Credentials.from_service_account_file(
                    CREDENTIALS_FILE,
                    scopes=['https://www.googleapis.com/auth/spreadsheets.readonly']
                )
            except json.JSONDecodeError as e:
                st.error(
                    f"Google credentials file is not valid JSON: {CREDENTIALS_FILE}. "
                    "Use the full service account key JSON downloaded from Google Cloud."
                )
                st.caption(f"JSON parse error: line {e.lineno}, column {e.colno}: {e.msg}")
                return None
        else:
            # Try to load from environment variable
            creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
            if creds_json:
                try:
                    creds_info = json.loads(creds_json)
                except json.JSONDecodeError as e:
                    st.error("GOOGLE_CREDENTIALS_JSON is not valid JSON.")
                    st.caption(f"JSON parse error: line {e.lineno}, column {e.colno}: {e.msg}")
                    return None
                creds = Credentials.from_service_account_info(
                    creds_info,
                    scopes=['https://www.googleapis.com/auth/spreadsheets.readonly']
                )
            else:
                st.error("Google credentials not found. Please set GOOGLE_CREDENTIALS_FILE or GOOGLE_CREDENTIALS_JSON environment variable.")
                return None

        return gspread.authorize(creds)
    except Exception as e:
        st.error(f"Failed to authenticate with Google Sheets: {e}")
        return None

@st.cache_data(ttl=30)
def load_data_from_sheets(max_rows: int = 2000):
    """Load data from Google Sheets."""
    try:
        gc = _get_gspread_client()
        if not gc:
            return pd.DataFrame()

        # Open the spreadsheet
        sheet = gc.open_by_key(GOOGLE_SHEETS_ID).sheet1

        # Get all values (including headers) to handle duplicates
        all_values = sheet.get_all_values()

        if not all_values or len(all_values) < 2:
            return pd.DataFrame()

        # Get headers and handle duplicates
        headers = all_values[0]
        data_rows = all_values[1:]

        # Fix duplicate headers by adding suffixes
        seen_headers = {}
        fixed_headers = []
        for header in headers:
            if header in seen_headers:
                seen_headers[header] += 1
                fixed_headers.append(f"{header}_{seen_headers[header]}")
            else:
                seen_headers[header] = 0
                fixed_headers.append(header)

        # Convert to DataFrame
        df = pd.DataFrame(data_rows, columns=fixed_headers)
        df['_sheet_row'] = range(2, len(df) + 2)

        # Clean and process the data
        # Expected columns from Google Forms:
        # Timestamp (form submission), Temperature, Humidity, Device ID, Timestamp (device)

        # Create a smarter column mapping
        actual_columns = df.columns.tolist()

        # Map columns based on content/position
        column_mapping = {}
        for i, col in enumerate(actual_columns):
            col_lower = col.lower()
            if 'timestamp' in col_lower and i == 0:
                column_mapping[col] = 'received_at'  # First timestamp is form submission
            elif 'temperature' in col_lower:
                column_mapping[col] = 'temperature'
            elif 'humidity' in col_lower:
                column_mapping[col] = 'humidity'
            elif 'device' in col_lower:
                column_mapping[col] = 'device_id'
            elif 'timestamp' in col_lower and i > 0:
                column_mapping[col] = 'device_timestamp'  # Later timestamp is from device

        # Apply the mapping
        if column_mapping:
            df = df.rename(columns=column_mapping)

        # Convert data types
        if 'temperature' in df.columns:
            df['temperature'] = pd.to_numeric(df['temperature'], errors='coerce')
        if 'humidity' in df.columns:
            df['humidity'] = pd.to_numeric(df['humidity'], errors='coerce')

        numeric_columns = [col for col in ['temperature', 'humidity'] if col in df.columns]
        if numeric_columns:
            df = df.dropna(subset=numeric_columns)

        # Parse timestamps
        if 'received_at' in df.columns:
            # Parse the timestamp and handle timezone properly
            df['received_at'] = pd.to_datetime(df['received_at'], errors='coerce')

            # If no timezone info, assume it's already in local time from Google Forms
            if df['received_at'].dt.tz is None:
                local_tz = _local_timezone()
                # Localize to local timezone first, then convert to UTC for internal use
                df['received_at'] = df['received_at'].dt.tz_localize(local_tz, ambiguous='infer')

            # Convert to UTC for internal processing
            df['ts_utc'] = df['received_at'].dt.tz_convert('UTC')

            # Keep display version in local timezone
            df['display_ts'] = df['received_at']
            df['ts'] = df['display_ts']  # Use local time as primary timestamp

        # Sort by newest first and limit rows
        if 'ts_utc' in df.columns:
            df = df.sort_values(
                by=['ts_utc', '_sheet_row'],
                ascending=[False, False],
                na_position='last',
            )
        else:
            df = df.sort_values(by='_sheet_row', ascending=False)

        df = df.head(max_rows).reset_index(drop=True)
        df['id'] = df['_sheet_row']

        return df

    except Exception as e:
        st.error(f"Error loading data from Google Sheets: {e}")
        return pd.DataFrame()

@st.cache_data(ttl=60)
def load_devices():
    """Load distinct devices from the sheet."""
    df = load_data_from_sheets(1000)  # Sample from recent data
    if df.empty or 'device_id' not in df.columns:
        return []

    devices = []
    for device_id in df['device_id'].dropna().unique():
        devices.append({
            'device_id': device_id,
            'device_name': f"ESP32-{device_id[-4:]}" if device_id else "Unknown"
        })
    return devices

def sheets_health():
    """Check if we can connect to Google Sheets."""
    try:
        gc = _get_gspread_client()
        if not gc:
            return False
        gc.open_by_key(GOOGLE_SHEETS_ID)
        return True
    except Exception:
        return False

# Sidebar controls
st.sidebar.title("Settings")
st.sidebar.write("Data Source: Google Sheets")

# Timezone selection
common_timezones = [
    'US/Pacific', 'US/Mountain', 'US/Central', 'US/Eastern',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome',
    'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney', 'UTC'
]

# Auto-detect current timezone
local_tz = _local_timezone()
current_tz_str = getattr(local_tz, 'key', str(local_tz)) if local_tz else 'UTC'

# Find current timezone in the list, or add it
if current_tz_str not in common_timezones:
    timezone_options = [current_tz_str] + common_timezones
else:
    timezone_options = common_timezones

if 'selected_timezone' not in st.session_state:
    st.session_state.selected_timezone = current_tz_str

default_index = timezone_options.index(st.session_state.selected_timezone) if st.session_state.selected_timezone in timezone_options else 0

selected_tz = st.sidebar.selectbox(
    "Timezone",
    timezone_options,
    index=default_index,
    key='selected_timezone'
)

# Update local_tz based on selection
local_tz = _local_timezone()
tz_label = getattr(local_tz, 'key', str(local_tz)) if local_tz else 'UTC'

# Status and refresh
health_ok = sheets_health()
st.sidebar.write("Google Sheets:", "✅ Connected" if health_ok else "❌ Error")

max_rows = st.sidebar.slider("Max rows", 500, 20000, 4000, step=500)

auto_refresh = st.sidebar.checkbox("Auto-refresh data", value=False)
refresh_interval = st.sidebar.slider("Refresh interval (seconds)", 5, 60, 30) if auto_refresh else 30

# Device filter
devices = load_devices()
device_options = ["All devices"] + [d['device_id'] for d in devices]
selected_device = st.sidebar.selectbox("Device", device_options)
device_id_filter = None if selected_device == "All devices" else selected_device

# Time range
time_preset = st.sidebar.selectbox("Time Range", ["Last Hour", "Last 12 Hours", "Last 24 Hours", "Last Week", "All Data"], index=2)

# Units toggle
use_f = st.sidebar.toggle("Show Fahrenheit", value=False)

# Load the data
df = load_data_from_sheets(max_rows=max_rows)

# Apply device filter
if device_id_filter and 'device_id' in df.columns:
    df = df[df['device_id'] == device_id_filter]

# Apply time filter
if time_preset != "All Data" and 'ts_utc' in df.columns:
    now = datetime.now(timezone.utc)
    hours_dict = {"Last Hour": 1, "Last 12 Hours": 12, "Last 24 Hours": 24, "Last Week": 168}
    if time_preset in hours_dict:
        start_time = now - timedelta(hours=hours_dict[time_preset])
        df = df[df['ts_utc'] >= start_time]

# Check if data is available
if df.empty:
    st.warning("No data available. Make sure your ESP32 is sending data to Google Forms and you have the correct credentials.")
else:
    # Create dashboard layout
    col1, col2 = st.columns(2)

    # Current readings in the first column
    with col1:
        st.subheader("Current Readings")
        latest = df.iloc[0]

        # Current temperature with gauge
        if 'temperature' in df.columns:
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
            st.plotly_chart(fig_temp_gauge, width="stretch")

        # Current humidity with gauge
        if 'humidity' in df.columns:
            current_hum = float(latest['humidity'])
            delta_hum = None
            if len(df) > 1:
                delta_hum = f"{current_hum - float(df.iloc[1]['humidity']):.1f}%"
            st.metric("Humidity", f"{current_hum:.1f}%", delta_hum)

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
            st.plotly_chart(fig_hum_gauge, width="stretch")

    # Historical data in the second column
    with col2:
        st.subheader("Historical Trends")

        # Check if filtered data is available
        if df.empty:
            st.warning(f"No data available for {time_preset}.")
        else:
            # Combined dual-axis chart
            x_col = 'display_ts' if 'display_ts' in df.columns else (
                'ts_utc' if 'ts_utc' in df.columns else (
                    'received_at' if 'received_at' in df.columns else None))

            if x_col is None or 'temperature' not in df.columns:
                st.warning("Insufficient data columns to plot chart.")
            else:
                df_plot = df.copy()
                if use_f and 'temperature' in df_plot.columns:
                    df_plot['temp_display'] = df_plot['temperature'] * 9/5 + 32
                    t_label = 'Temperature (°F)'
                else:
                    df_plot['temp_display'] = df_plot['temperature']
                    t_label = 'Temperature (°C)'

                fig = go.Figure()
                fig.add_trace(go.Scatter(x=df_plot[x_col], y=df_plot['temp_display'], name=t_label, yaxis='y1', mode='lines'))
                if 'humidity' in df_plot.columns:
                    fig.add_trace(go.Scatter(x=df_plot[x_col], y=df_plot['humidity'], name='Humidity (%)', yaxis='y2', mode='lines'))

                fig.update_layout(
                    title='Temperature and Humidity Over Time',
                    xaxis_title='Time',
                    yaxis=dict(title=t_label, side='left', range=[df_plot['temp_display'].min()*0.95, df_plot['temp_display'].max()*1.05]),
                    yaxis2=dict(title='Humidity (%)', overlaying='y', side='right', range=[0, 100]) if 'humidity' in df_plot.columns else None,
                    legend=dict(orientation='h')
                )
                st.plotly_chart(fig, width="stretch")

    # Data statistics and table
    st.subheader("Data Statistics")
    col_stats1, col_stats2, col_stats3, col_stats4 = st.columns(4)

    with col_stats1:
        st.metric("Total Records (loaded)", f"{len(df)}")

    with col_stats2:
        if 'temperature' in df.columns:
            avg_c = float(df['temperature'].mean()) if not df['temperature'].empty else 0.0
            avg_disp = (avg_c * 9/5 + 32) if use_f else avg_c
            st.metric("Avg Temperature", f"{avg_disp:.1f}{'°F' if use_f else '°C'}")

    with col_stats3:
        if 'humidity' in df.columns:
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
