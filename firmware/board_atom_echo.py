"""Board config: M5Stack Atom Echo (ESP32-PICO, no PSRAM).

Shared 2.4 GHz radio requires deactivating BLE after each scan so WiFi
can reconnect.  ~100 KB free RAM demands aggressive garbage collection.
"""

BOARD_NAME = "atom_echo"

# BLE/WiFi coexistence — shared radio, must deactivate BLE after scan
DEACTIVATE_BLE_AFTER_SCAN = True
CONTINUOUS_SCAN = False

# Scan timing
SCAN_INTERVAL_MS = 5000
SCAN_DURATION_MS = 8000

# Memory-constrained: cap raw IRQ results
MAX_SCAN_ENTRIES = 200

# GATT connect tuning (#139). No PSRAM: shorter connect/scan window + retries
# (with a GC between) to ease IDF-heap and shared-radio pressure during a NimBLE
# central connection.
CONNECT_TIMEOUT_MS = 10000
CONNECT_SCAN_MS = 8000
CONNECT_RETRIES = 2

# Pre-connect IDF-heap guard floors (#139). Default 0 = pure always-on crash
# floor (ble_bridge.CRASH_FLOOR_*). Raise these only after measuring a real
# successful-connect heap delta on a PSRAM board: set CONNECT_MIN_IDF_FREE a
# little above the observed (free_before - free_after) connection cost and
# CONNECT_MIN_IDF_LARGEST a little above the observed post-connect largest
# floor. gc.collect() cannot hand kilobytes back to the IDF heap, so a non-zero
# value here only ever produces a clean skip, never a successful connect, on a
# no-PSRAM board with WiFi up.
CONNECT_MIN_IDF_LARGEST = 0
CONNECT_MIN_IDF_FREE = 0

# Aggressive GC to avoid OOM (~100 KB free after imports)
AGGRESSIVE_GC = True
GC_INTERVAL = 200  # main-loop iterations between gc.collect()

# I2S speaker (NS4168 DAC)
HAS_BEEP = True
BEEP_PINS = {"sck": 19, "ws": 33, "sd": 22}

# No display
HAS_DISPLAY = False


def on_scan_complete(results, scale_found):
    """No-op for headless board."""
    pass
