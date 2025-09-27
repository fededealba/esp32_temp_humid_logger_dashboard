from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from datetime import datetime
import logging
import sqlite3
import os
import shutil

app = Flask(__name__)

# Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
app.logger.setLevel(logging.INFO)

# Database path: use instance folder; migrate old DB if present
old_db_path = os.path.join(os.getcwd(), 'weather_data.db')
os.makedirs(app.instance_path, exist_ok=True)
db_path = os.path.join(app.instance_path, 'weather_data.db')
if os.path.exists(old_db_path) and not os.path.exists(db_path):
    try:
        shutil.move(old_db_path, db_path)
        app.logger.info(f"Moved existing DB from {old_db_path} to {db_path}")
    except Exception as e:
        app.logger.warning(f"Could not move old DB: {e}. Using instance DB path {db_path}")

app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)

app.logger.info(f"Using database at: {db_path}")

# Config: optional API key required for ingestion
API_KEY = os.environ.get('INGEST_API_KEY')  # if set, require X-Api-Key header

# Database Model (expanded)
class WeatherData(db.Model):
    __tablename__ = 'weather_data'
    id = db.Column(db.Integer, primary_key=True)
    temperature = db.Column(db.Float, nullable=False)
    humidity = db.Column(db.Float, nullable=False)
    # Device-supplied time data (optional)
    device_time_hms = db.Column(db.String(8))          # HH:MM:SS
    device_timestamp = db.Column(db.String(25))        # ISO-8601
    device_epoch = db.Column(db.Integer)               # Unix seconds
    # Device metadata
    device_id = db.Column(db.String(32))               # e.g., MAC
    device_name = db.Column(db.String(64))
    fw = db.Column(db.String(32))
    # Server-side receipt time (UTC string)
    received_at = db.Column(db.String(20), nullable=False)


def _ensure_schema():
    """Create tables then add any missing columns / indexes for SQLite."""
    with app.app_context():
        db.create_all()
        # Add missing columns if table exists from old version
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            cur.execute("PRAGMA table_info(weather_data);")
            cols = {row[1] for row in cur.fetchall()}
            # Columns to ensure exist
            wanted = {
                ('device_time_hms', "TEXT"),
                ('device_timestamp', "TEXT"),
                ('device_epoch', "INTEGER"),
                ('device_id', "TEXT"),
                ('device_name', "TEXT"),
                ('fw', "TEXT"),
            }
            for name, decl in wanted:
                if name not in cols:
                    cur.execute(f"ALTER TABLE weather_data ADD COLUMN {name} {decl}")
                    app.logger.info(f"Added column {name} to weather_data")
            # Indexes
            cur.execute("CREATE INDEX IF NOT EXISTS idx_weather_received_at ON weather_data(received_at)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_weather_device_received ON weather_data(device_id, received_at)")
            conn.commit()
            conn.close()
        except Exception as e:
            app.logger.warning(f"Schema ensure failed: {e}")


_ensure_schema()


def _require_api_key():
    if API_KEY:
        header_key = request.headers.get('X-Api-Key', '')
        if header_key != API_KEY:
            return jsonify({'error': 'Unauthorized'}), 401
    return None


def _parse_iso8601(s: str) -> bool:
    try:
        # Accept basic format 2025-09-07T21:34:00Z
        datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ')
        return True
    except Exception:
        return False


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'}), 200


# Endpoint to receive data from ESP32
@app.route('/data', methods=['POST'])
def receive_data():
    auth = _require_api_key()
    if auth is not None:
        return auth

    if not request.is_json:
        return jsonify({'error': 'Content-Type must be application/json'}), 415

    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'No JSON body provided'}), 400

    # Required fields
    missing = [k for k in ['temperature', 'humidity'] if k not in data]
    if missing:
        return jsonify({'error': f'Missing required fields: {", ".join(missing)}'}), 400

    # Validate numeric ranges
    try:
        temperature = float(data['temperature'])
        humidity = float(data['humidity'])
    except Exception:
        return jsonify({'error': 'temperature and humidity must be numbers'}), 400

    if not (-40.0 <= temperature <= 85.0):
        return jsonify({'error': 'temperature out of range (-40..85)'}), 400
    if not (0.0 <= humidity <= 100.0):
        return jsonify({'error': 'humidity out of range (0..100)'}), 400

    # Optional fields from device
    device_time_hms = data.get('time')
    device_timestamp = data.get('timestamp')
    device_epoch = data.get('epoch')
    device_id = data.get('device')
    device_name = data.get('name')
    fw = data.get('fw')

    # Basic format checks
    if device_time_hms and (not isinstance(device_time_hms, str) or len(device_time_hms) != 8):
        return jsonify({'error': 'time must be HH:MM:SS'}), 400
    if device_timestamp and (not isinstance(device_timestamp, str) or not _parse_iso8601(device_timestamp)):
        return jsonify({'error': 'timestamp must be ISO-8601 like 2025-09-07T21:34:00Z'}), 400
    if device_epoch is not None:
        try:
            device_epoch = int(device_epoch)
        except Exception:
            return jsonify({'error': 'epoch must be an integer'}), 400

    # Server receipt time (UTC)
    received_at = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')

    try:
        new_entry = WeatherData(
            temperature=temperature,
            humidity=humidity,
            device_time_hms=device_time_hms,
            device_timestamp=device_timestamp,
            device_epoch=device_epoch,
            device_id=device_id,
            device_name=device_name,
            fw=fw,
            received_at=received_at,
        )
        db.session.add(new_entry)
        db.session.commit()
        app.logger.info(f"Stored weather row id={new_entry.id} dev={device_id} at {received_at}")
        return jsonify({
            'id': new_entry.id,
            'temperature': new_entry.temperature,
            'humidity': new_entry.humidity,
            'device_time_hms': new_entry.device_time_hms,
            'device_timestamp': new_entry.device_timestamp,
            'device_epoch': new_entry.device_epoch,
            'device_id': new_entry.device_id,
            'device_name': new_entry.device_name,
            'fw': new_entry.fw,
            'received_at': new_entry.received_at,
        }), 201
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"Error processing data: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/data', methods=['GET'])
def list_data():
    """Paginated list with optional filters: device_id, from, to.
    Query params: page (1..), per_page (1..500), device_id, from, to
    """
    try:
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 50))
    except Exception:
        return jsonify({'error': 'page and per_page must be integers'}), 400
    per_page = max(1, min(per_page, 500))

    device_id = request.args.get('device_id')
    start = request.args.get('from')  # 'YYYY-MM-DD HH:MM:SS'
    end = request.args.get('to')

    q = WeatherData.query
    if device_id:
        q = q.filter(WeatherData.device_id == device_id)
    if start:
        q = q.filter(WeatherData.received_at >= start)
    if end:
        q = q.filter(WeatherData.received_at <= end)

    items = q.order_by(WeatherData.id.desc()).paginate(page=page, per_page=per_page, error_out=False)
    result = [{
        'id': r.id,
        'temperature': r.temperature,
        'humidity': r.humidity,
        'device_time_hms': r.device_time_hms,
        'device_timestamp': r.device_timestamp,
        'device_epoch': r.device_epoch,
        'device_id': r.device_id,
        'device_name': r.device_name,
        'fw': r.fw,
        'received_at': r.received_at,
    } for r in items.items]

    return jsonify({
        'page': items.page,
        'pages': items.pages,
        'total': items.total,
        'per_page': items.per_page,
        'data': result,
    })


@app.route('/check', methods=['GET'])
def check_db():
    count = WeatherData.query.count()
    sample = WeatherData.query.order_by(WeatherData.id.desc()).limit(5).all()
    return jsonify({
        'database_path': db_path,
        'row_count': count,
        'sample_data': [
            {'id': r.id, 'temperature': r.temperature, 'humidity': r.humidity, 'received_at': r.received_at}
            for r in sample
        ],
    })


@app.route('/log', methods=['GET'])
def show_log():
    rows = WeatherData.query.order_by(WeatherData.id.asc()).all()
    result = [{
        'id': r.id,
        'temperature': r.temperature,
        'humidity': r.humidity,
        'device_time_hms': r.device_time_hms,
        'device_timestamp': r.device_timestamp,
        'device_epoch': r.device_epoch,
        'device_id': r.device_id,
        'device_name': r.device_name,
        'fw': r.fw,
        'received_at': r.received_at,
    } for r in rows]
    app.logger.info(f"Returned {len(result)} records")
    return jsonify(result)


if __name__ == '__main__':
    # In production, prefer gunicorn/uwsgi and disable debug
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_ENV', 'production') == 'development'
    app.run(host='0.0.0.0', port=port, debug=debug)
