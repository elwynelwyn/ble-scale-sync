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

# GATT connect tuning (#139). A healthy connect to a continuously advertising
# scale takes 2-4 s, so a short window plus a retry recovers from a hung attempt
# within ~7 s instead of waiting out one long window.
CONNECT_TIMEOUT_MS = 6000
CONNECT_SCAN_MS = 6000
CONNECT_RETRIES = 2

# Pre-connect IDF-heap guard floors (#139). Default 0 keeps the gate at the
# always-on crash floor; this PSRAM board has ample IDF headroom so it never
# trips.
CONNECT_MIN_IDF_LARGEST = 0
CONNECT_MIN_IDF_FREE = 0

# No memory pressure
AGGRESSIVE_GC = False
GC_INTERVAL = 1000  # infrequent GC

# MAX98357A I2S amp + speaker
HAS_BEEP = True
BEEP_PINS = {"sck": 4, "ws": 5, "sd": 6}  # BCLK=GPIO4, LRC/WS=GPIO5, DIN=GPIO6

# No display
HAS_DISPLAY = False


def on_scan_complete(results, scale_found):
    """No-op for headless board."""
    pass
