#!/usr/bin/env python3
"""
Start the Flask server and then the Streamlit dashboard.

Usage:
  python scripts/start_all.py [--port 5001] [--host 0.0.0.0] [--ingest-api-key KEY]

Assumptions:
- You have installed dependencies:
    pip install -r server/requirements.txt -r dashboard/requirements.txt
- Run from the repository root (script resolves relative paths).
"""

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError


ROOT = Path(__file__).resolve().parent.parent
SERVER_APP = ROOT / "server" / "app.py"
DASHBOARD_APP = ROOT / "dashboard" / "app.py"


def wait_for_health(url: str, timeout: float = 30.0, interval: float = 0.5) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=2) as resp:  # nosec - local dev
                if resp.status == 200:
                    return True
        except URLError:
            pass
        time.sleep(interval)
    return False


def main():
    parser = argparse.ArgumentParser(description="Start Flask server then Streamlit dashboard")
    parser.add_argument("--port", type=int, default=5001, help="Server port (default 5001)")
    parser.add_argument("--host", default="0.0.0.0", help="Server host bind (default 0.0.0.0)")
    parser.add_argument("--ingest-api-key", dest="api_key", default=None, help="Optional API key for server/dashboard")
    args = parser.parse_args()

    if not SERVER_APP.exists() or not DASHBOARD_APP.exists():
        print("Error: expected server/app.py and dashboard/app.py to exist.", file=sys.stderr)
        sys.exit(1)

    env_server = os.environ.copy()
    if args.api_key:
        env_server["INGEST_API_KEY"] = args.api_key

    # Start Flask server
    server_cmd = [sys.executable, str(SERVER_APP)]
    print(f"Starting Flask server: {' '.join(server_cmd)}")
    server_proc = subprocess.Popen(server_cmd, cwd=str(ROOT / "server"), env=env_server)

    api_base = f"http://localhost:{args.port}"
    health_url = f"{api_base}/health"
    print(f"Waiting for server health at {health_url} ...")
    up = wait_for_health(health_url, timeout=40.0)
    if not up:
        print("Warning: server health not detected; continuing anyway.")

    # Start Streamlit dashboard
    env_dash = os.environ.copy()
    env_dash["API_BASE_URL"] = api_base
    if args.api_key:
        env_dash["DASHBOARD_API_KEY"] = args.api_key
    # Use the same interpreter to run Streamlit to honor the active conda env
    dash_cmd = [sys.executable, "-m", "streamlit", "run", str(DASHBOARD_APP)]
    print(f"Starting dashboard: {' '.join(dash_cmd)}")
    dash_proc = subprocess.Popen(dash_cmd, cwd=str(ROOT / "dashboard"), env=env_dash)

    try:
        # Wait on dashboard; if it exits, shut down server
        rc = dash_proc.wait()
        print(f"Dashboard exited with code {rc}; stopping server...")
    except KeyboardInterrupt:
        print("Keyboard interrupt received; stopping processes...")
    finally:
        for proc, name in [(dash_proc, "dashboard"), (server_proc, "server")]:
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                except Exception:
                    pass
        print("All processes stopped.")


if __name__ == "__main__":
    main()
