#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SKETCH_DIR="${SKETCH_DIR:-$ROOT_DIR/firmware/temp_hum_complete}"
FQBN="${FQBN:-esp32:esp32:esp32}"
PORT="${PORT:-}"
BAUD="${BAUD:-115200}"
UPLOAD_SPEED="${UPLOAD_SPEED:-115200}"
# huge_app trades away OTA support (never used here; flashing is always via
# USB) for a 3MB app partition instead of the default 1.2MB. NimBLE-Arduino
# alone pushed the default partition to 99% full.
PARTITION_SCHEME="${PARTITION_SCHEME:-huge_app}"
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
  upload     Upload firmware to PORT
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
  SKETCH_DIR        Sketch directory, default: $SKETCH_DIR
  ESP32_INDEX_URL   ESP32 board package URL
  LOCAL_BIN_DIR     Local arduino-cli install directory, default: $LOCAL_BIN_DIR

Examples:
  scripts/firmware.sh install-cli
  scripts/firmware.sh setup
  scripts/firmware.sh compile
  PORT=/dev/ttyUSB0 scripts/firmware.sh upload
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
