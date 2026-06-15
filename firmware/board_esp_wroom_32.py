"""Board config: Generic ESP-WROOM-32 dev board (stock ESP32, no PSRAM).

BLE and WiFi share the 2.4 GHz radio in software, so BLE must be deactivated
after each scan to let WiFi reconnect.  After MicroPython + aioble + mqtt_as
imports there is only ~90 KB free heap (similar to the Atom Echo, not the
~250 KB a bare module reports), so the raw scan buffer must stay small: a
noisy environment otherwise exhausts the heap mid-scan and NimBLE crashes
on a failed semaphore allocation (Guru Meditation, reboot loop).
"""

BOARD_NAME = "esp_wroom_32"

# BLE/WiFi coexistence - shared radio, must deactivate BLE after scan
DEACTIVATE_BLE_AFTER_SCAN = True
CONTINUOUS_SCAN = False

# Scan timing - shorter window than the S3 to limit raw-buffer growth
SCAN_INTERVAL_MS = 5000
SCAN_DURATION_MS = 5000

# Memory-constrained: cap raw IRQ results well below the Atom Echo's 200.
# This is a conservative starting point for noisy environments, not a tuned
# value - raise it if the scale is missed, lower it on OOM. The IRQ handler
# in ble_bridge.py drops entries past this cap without crashing.
MAX_SCAN_ENTRIES = 80

# GATT connect tuning (#139). No PSRAM, so the IDF heap is tight for a NimBLE
# central connection: use a shorter connect/scan window and retry (with a GC
# between attempts) instead of one long window that holds the shared radio.
CONNECT_TIMEOUT_MS = 10000
CONNECT_SCAN_MS = 8000
CONNECT_RETRIES = 2

AGGRESSIVE_GC = True
GC_INTERVAL = 200

# No I2S speaker
HAS_BEEP = False
BEEP_PINS = None

# No display
HAS_DISPLAY = False


def on_scan_complete(results, scale_found):
    """No-op for headless board."""
    pass
