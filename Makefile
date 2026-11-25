FQBN ?= esp32:esp32:esp32
PORT ?=
BAUD ?= 115200
UPLOAD_SPEED ?= 115200
PARTITION_SCHEME ?= min_spiffs
OTA_HOST ?= esp32-weather.local

export FQBN
export PORT
export BAUD
export UPLOAD_SPEED
export PARTITION_SCHEME
export OTA_HOST

.PHONY: firmware-help firmware-install-cli firmware-setup firmware-compile firmware-upload firmware-upload-ota firmware-monitor firmware-ports firmware-boards

firmware-help:
	./scripts/firmware.sh help

firmware-install-cli:
	./scripts/firmware.sh install-cli

firmware-setup:
	./scripts/firmware.sh setup

firmware-compile:
	./scripts/firmware.sh compile

firmware-upload:
	./scripts/firmware.sh upload

firmware-upload-ota:
	./scripts/firmware.sh upload-ota

firmware-monitor:
	./scripts/firmware.sh monitor

firmware-ports:
	./scripts/firmware.sh ports

firmware-boards:
	./scripts/firmware.sh boards
