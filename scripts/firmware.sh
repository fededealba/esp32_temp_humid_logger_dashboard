#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SKETCH_DIR="${SKETCH_DIR:-$ROOT_DIR/firmware/temp_hum_complete}"
FQBN="${FQBN:-esp32:esp32:esp32}"
PORT="${PORT:-}"
BAUD="${BAUD:-115200}"
UPLOAD_SPEED="${UPLOAD_SPEED:-115200}"
# min_spiffs: two 1.9MB app slots (OTA writes the new image into the
# inactive one) plus a 128KB SPIFFS the sketch doesn't use. The default
# scheme's 1.2MB slots are too small: NimBLE-Arduino alone pushed it to 99%
# full. Switching schemes rewrites the partition table, which only a USB
# upload can do.
PARTITION_SCHEME="${PARTITION_SCHEME:-min_spiffs}"
OTA_HOST="${OTA_HOST:-esp32-weather.local}"
OTA_PORT="${OTA_PORT:-3232}"
SECRETS_FILE="${SECRETS_FILE:-$SKETCH_DIR/secrets.h}"
ESP32_INDEX_URL="${ESP32_INDEX_URL:-https://espressif.github.io/arduino-esp32/package_esp32_index.json}"
TOOLS_DIR="${TOOLS_DIR:-$ROOT_DIR/.tools}"
LOCAL_BIN_DIR="${LOCAL_BIN_DIR:-$TOOLS_DIR/bin}"
ARDUINO_CLI_INSTALL_URL="${ARDUINO_CLI_INSTALL_URL:-https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh}"
ARDUINO_CLI=""

resolve_cli() {
  if [ -x "$LOCAL_BIN_DIR/arduino-cli" ]; then
    ARDUINO_CLI="$LOCAL_BIN_DIR/arduino-cli"
    return 0
  fi

  if command -v arduino-cli >/dev/null 2>&1; then
    ARDUINO_CLI="$(command -v arduino-cli)"
    return 0
  fi

  return 1
}

usage() {
  cat <<EOF
Usage: scripts/firmware.sh <command>

Commands:
  install-cli Install arduino-cli into .tools/bin when missing
  setup      Install/update ESP32 board support and sketch libraries
  compile    Compile the firmware sketch
  upload     Upload firmware to PORT (USB)
  upload-ota Upload firmware over WiFi to OTA_HOST
  monitor    Open serial monitor on PORT
  ports      List connected boards/serial ports
  boards     List installed and available ESP32 board FQBNs
  version    Show arduino-cli version
  help       Show this help

Environment:
  FQBN              Board FQBN, default: $FQBN
  PORT              Serial port for upload/monitor, for example /dev/ttyUSB0
  BAUD              Serial monitor baud rate, default: $BAUD
  UPLOAD_SPEED      ESP32 upload speed, default: $UPLOAD_SPEED
  PARTITION_SCHEME  Partition scheme, default: $PARTITION_SCHEME
  OTA_HOST          Hostname or IP for upload-ota, default: $OTA_HOST
  OTA_PASSWORD      OTA password, default: read from secrets.h
  SKETCH_DIR        Sketch directory, default: $SKETCH_DIR
  ESP32_INDEX_URL   ESP32 board package URL
  LOCAL_BIN_DIR     Local arduino-cli install directory, default: $LOCAL_BIN_DIR

Examples:
  scripts/firmware.sh install-cli
  scripts/firmware.sh setup
  scripts/firmware.sh compile
  PORT=/dev/ttyUSB0 scripts/firmware.sh upload
  scripts/firmware.sh upload-ota
  OTA_HOST=192.168.1.50 scripts/firmware.sh upload-ota
  PORT=/dev/ttyUSB0 scripts/firmware.sh monitor
  FQBN=esp32:esp32:esp32doit-devkit-v1 scripts/firmware.sh compile
EOF
}

install_cli() {
  if resolve_cli; then
    printf 'Using arduino-cli: %s\n' "$ARDUINO_CLI"
    "$ARDUINO_CLI" version
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    cat >&2 <<EOF
Error: curl is required to install arduino-cli.

Install curl or install arduino-cli manually:
  https://arduino.github.io/arduino-cli/latest/installation/
EOF
    exit 127
  fi

  mkdir -p "$LOCAL_BIN_DIR"
  printf 'Installing arduino-cli into %s ...\n' "$LOCAL_BIN_DIR"
  curl -fsSL "$ARDUINO_CLI_INSTALL_URL" | BINDIR="$LOCAL_BIN_DIR" sh

  if ! resolve_cli; then
    cat >&2 <<EOF
Error: arduino-cli installation finished, but no executable was found at:
  $LOCAL_BIN_DIR/arduino-cli
EOF
    exit 1
  fi

  "$ARDUINO_CLI" version
}

require_cli() {
  if ! resolve_cli; then
    cat >&2 <<EOF
Error: arduino-cli is not installed.

Install it locally first, then rerun this command:
  scripts/firmware.sh install-cli
EOF
    exit 127
  fi
}

require_port() {
  if [ -z "$PORT" ]; then
    cat >&2 <<EOF
Error: PORT is required for this command.

List ports:
  scripts/firmware.sh ports

Then run, for example:
  PORT=/dev/ttyUSB0 scripts/firmware.sh $1
EOF
    exit 2
  fi
}

# OTA password: $OTA_PASSWORD if set, else the OTA_PASSWORD #define in
# secrets.h (the same value the firmware was built with).
ota_password() {
  if [ -n "${OTA_PASSWORD:-}" ]; then
    printf '%s' "$OTA_PASSWORD"
    return 0
  fi
  if [ -f "$SECRETS_FILE" ]; then
    sed -n 's/^[[:space:]]*#define[[:space:]][[:space:]]*OTA_PASSWORD[[:space:]][[:space:]]*"\(.*\)".*/\1/p' "$SECRETS_FILE" | head -n 1
  fi
}

# espota.py ships with the installed ESP32 core; use the newest version.
find_espota() {
  data_dir="$("$ARDUINO_CLI" config get directories.data 2>/dev/null || true)"
  [ -n "$data_dir" ] || data_dir="$HOME/.arduino15"
  ls -d "$data_dir"/packages/esp32/hardware/esp32/*/tools/espota.py 2>/dev/null | sort -V | tail -n 1
}

cmd="${1:-help}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  install-cli)
    install_cli
    ;;
  setup)
    install_cli
    "$ARDUINO_CLI" core update-index --additional-urls "$ESP32_INDEX_URL"
    "$ARDUINO_CLI" core install esp32:esp32 --additional-urls "$ESP32_INDEX_URL"
    "$ARDUINO_CLI" lib install "DHT sensor library"
    "$ARDUINO_CLI" lib install "Adafruit Unified Sensor"
    "$ARDUINO_CLI" lib install "ArduinoJson"
    "$ARDUINO_CLI" lib install "NimBLE-Arduino"
    ;;
  compile)
    require_cli
    "$ARDUINO_CLI" compile --fqbn "$FQBN" --board-options "PartitionScheme=$PARTITION_SCHEME" "$@" "$SKETCH_DIR"
    ;;
  upload)
    require_cli
    require_port "$cmd"
    "$ARDUINO_CLI" compile --upload --port "$PORT" --fqbn "$FQBN" --board-options "PartitionScheme=$PARTITION_SCHEME,UploadSpeed=$UPLOAD_SPEED" "$@" "$SKETCH_DIR"
    ;;
  upload-ota)
    require_cli
    password="$(ota_password)"
    if [ -z "$password" ]; then
      cat >&2 <<EOF
Error: no OTA password. Define OTA_PASSWORD in $SECRETS_FILE (see
secrets.example.h) and flash once over USB, or set OTA_PASSWORD in the env.
EOF
      exit 2
    fi
    espota="$(find_espota)"
    if [ -z "$espota" ]; then
      echo "Error: espota.py not found; run scripts/firmware.sh setup first." >&2
      exit 127
    fi
    build_dir="$TOOLS_DIR/build"
    "$ARDUINO_CLI" compile --fqbn "$FQBN" --board-options "PartitionScheme=$PARTITION_SCHEME" --output-dir "$build_dir" "$@" "$SKETCH_DIR"
    bin="$build_dir/$(basename "$SKETCH_DIR").ino.bin"
    printf 'Uploading %s to %s:%s over WiFi...\n' "$bin" "$OTA_HOST" "$OTA_PORT"
    # The device only services OTA between phases of its ~60s sensor cycle;
    # if the invitation times out mid-cycle, just rerun.
    python3 "$espota" -r -i "$OTA_HOST" -p "$OTA_PORT" --auth="$password" -f "$bin"
    ;;
  monitor)
    require_cli
    require_port "$cmd"
    "$ARDUINO_CLI" monitor --port "$PORT" --config "baudrate=$BAUD,dtr=off,rts=off" "$@"
    ;;
  ports)
    require_cli
    "$ARDUINO_CLI" board list "$@"
    ;;
  boards)
    require_cli
    "$ARDUINO_CLI" board listall esp32 "$@"
    ;;
  version)
    require_cli
    "$ARDUINO_CLI" version "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$cmd" >&2
    usage >&2
    exit 2
    ;;
esac
