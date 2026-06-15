"""Board config: Generic ESP32-S3 (16 MB flash, 8 MB PSRAM).

BLE and WiFi still share one 2.4 GHz radio via time-division coexistence (as on
the classic ESP32), but the PSRAM gives plenty of RAM, so BLE can stay active
between scans and there is IDF-heap headroom for large scan buffers and a NimBLE
GATT connection. No need to deactivate BLE after scanning.
"""

BOARD_NAME = "esp32_s3"

# BLE/WiFi coexistence — shared radio, but ample PSRAM, so no deactivation needed
DEACTIVATE_BLE_AFTER_SCAN = False
CONTINUOUS_SCAN = True
PUBLISH_INTERVAL_MS = 2000   # drain+publish every 2s
SEEN_RESET_CYCLES = 5        # clear _seen every 5 drains (10s) to age out gone devices

# Scan timing (batch mode fallback)
SCAN_INTERVAL_MS = 2000
SCAN_DURATION_MS = 8000

# Large PSRAM — generous scan buffer
MAX_SCAN_ENTRIES = 500

# GATT connect tuning (#139). Ample PSRAM, so keep one long connect/scan window
# (matches the historical behavior for short-burst advertisers like Eufy P2 Pro).
CONNECT_TIMEOUT_MS = 15000
CONNECT_SCAN_MS = 15000
CONNECT_RETRIES = 1

# No memory pressure
AGGRESSIVE_GC = False
GC_INTERVAL = 1000  # infrequent GC

# No speaker
HAS_BEEP = False
BEEP_PINS = None

# No display
HAS_DISPLAY = False


def on_scan_complete(results, scale_found):
    """No-op for headless board."""
    pass
