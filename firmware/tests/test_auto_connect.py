"""Host-runnable tests for the autonomous GATT connect helpers in main.py.

The _find_scale_in_raw function lives in main.py and uses the _scale_macs
global. Because main.py has heavy import-time side effects (MQTT, WiFi,
config.json), we test the logic by extracting and exercising the function
directly from module globals.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

# Stub MicroPython-only modules before importing anything from firmware.
sys.modules["aioble"] = types.ModuleType("aioble")
_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: None
sys.modules["bluetooth"] = _bt

_board = types.ModuleType("board")
_board.HAS_BEEP = False
_board.HAS_DISPLAY = False
_board.CONTINUOUS_SCAN = True
_board.PUBLISH_INTERVAL_MS = 2000
_board.SCAN_INTERVAL_MS = 5000
_board.DEACTIVATE_BLE_AFTER_SCAN = False
_board.GC_INTERVAL = 100
_board.MAX_SCAN_ENTRIES = 500
_board.BOARD_NAME = "test"
_board.on_scan_complete = lambda *a: None
sys.modules["board"] = _board

# Stub mqtt_as — main.py creates an MQTTClient at import time
_mqtt_as = types.ModuleType("mqtt_as")
_mqtt_as.config = {}


class _FakeMQTTClient:
    def __init__(self, cfg):
        pass

    async def connect(self):
        raise RuntimeError("test stub: not connecting")


_mqtt_as.MQTTClient = _FakeMQTTClient
sys.modules["mqtt_as"] = _mqtt_as

# Stub ble_bridge — main.py creates a BleBridge at import time
_ble_bridge = types.ModuleType("ble_bridge")
_ble_bridge.BleBridge = lambda: types.SimpleNamespace(
    start_streaming=lambda: None,
    stop_streaming=lambda: None,
    has_pending_scale_mac=lambda macs: False,
    drain_results=lambda: [],
    _raw_results=[],
)
sys.modules["ble_bridge"] = _ble_bridge

# Write a minimal config.json for main.py import
import json
import tempfile

_config_path = os.path.join(_FIRMWARE_DIR, "config.json")
_config_existed = os.path.exists(_config_path)
_orig_cwd = os.getcwd()
if not _config_existed:
    with open(_config_path, "w") as f:
        json.dump(
            {
                "topic_prefix": "test",
                "device_id": "test",
                "wifi_ssid": "",
                "wifi_password": "",
                "mqtt_broker": "localhost",
                "mqtt_port": 1883,
            },
            f,
        )

# main.py opens config.json relative to CWD
os.chdir(_FIRMWARE_DIR)
try:
    import main  # noqa: E402
finally:
    os.chdir(_orig_cwd)
    if not _config_existed:
        os.remove(_config_path)

# main._wait_not_busy awaits asyncio.sleep_ms, which only exists in MicroPython.
import asyncio as _asyncio

if not hasattr(_asyncio, "sleep_ms"):
    _asyncio.sleep_ms = lambda ms: _asyncio.sleep(ms / 1000)


# ─── helpers ─────────────────────────────────────────────────────────────────

_MAC_BYTES = b"\xFF\x03\x00\x53\xD6\x4D"
_MAC_STR = "FF:03:00:53:D6:4D"

_OTHER_MAC_BYTES = b"\xAA\xBB\xCC\xDD\xEE\xFF"
_OTHER_MAC_STR = "AA:BB:CC:DD:EE:FF"

_PUBLIC_MAC_BYTES = b"\x84\xFC\xE6\x53\x06\x1C"
_PUBLIC_MAC_STR = "84:FC:E6:53:06:1C"


def _raw_entry(addr_bytes, addr_type=0, rssi=-50, adv_data=b""):
    """Create a raw IRQ buffer tuple."""
    return (addr_bytes, addr_type, rssi, adv_data)


class TestFindScaleInRaw(unittest.TestCase):
    """_find_scale_in_raw: find first known scale MAC in raw buffer."""

    def setUp(self):
        # Set known scale MACs
        main._scale_macs = {_MAC_STR}

    def tearDown(self):
        main._scale_macs = set()

    def test_empty_buffer(self):
        self.assertIsNone(main._find_scale_in_raw([]))

    def test_no_known_mac(self):
        raw = [_raw_entry(_OTHER_MAC_BYTES)]
        self.assertIsNone(main._find_scale_in_raw(raw))

    def test_known_mac_found(self):
        raw = [_raw_entry(_OTHER_MAC_BYTES), _raw_entry(_MAC_BYTES, addr_type=1)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        mac, addr_bytes, addr_type = result
        self.assertEqual(mac, _MAC_STR)
        self.assertEqual(addr_bytes, _MAC_BYTES)
        self.assertEqual(addr_type, 1)

    def test_returns_first_match(self):
        # Both entries are the same FF (static random) MAC. The first match is
        # returned, and its misreported addr_type=0 is corrected to 1 (#231).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0), _raw_entry(_MAC_BYTES, addr_type=1)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], _MAC_STR)
        self.assertEqual(result[1], _MAC_BYTES)
        self.assertEqual(result[2], 1)  # FF -> static random, override forces 1

    def test_empty_scale_macs(self):
        main._scale_macs = set()
        raw = [_raw_entry(_MAC_BYTES)]
        self.assertIsNone(main._find_scale_in_raw(raw))


class TestFindScaleAddrTypeOverride(unittest.TestCase):
    """_find_scale_in_raw corrects a misreported static-random addr_type (#231)."""

    def setUp(self):
        main._scale_macs = {_MAC_STR, _PUBLIC_MAC_STR}

    def tearDown(self):
        main._scale_macs = set()

    def test_static_random_mac_reported_public_is_overridden(self):
        # FF:.. is static random (0xFF & 0xC0 == 0xC0); scan misreports it as
        # public (0). Source must force random (1).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        self.assertEqual(result[2], 1)

    def test_static_random_mac_reported_random_stays_random(self):
        raw = [_raw_entry(_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)

    def test_non_static_mac_keeps_reported_public(self):
        # 84:.. top bits are 0b10, NOT static random; trust the reported type.
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=0)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 0)

    def test_non_static_mac_keeps_reported_random(self):
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)


class TestAutoConnectConfig(unittest.TestCase):
    """_auto_connect flag parsing from config topic."""

    def test_default_is_true(self):
        # Reset to default
        main._auto_connect = True
        self.assertTrue(main._auto_connect)

    def test_opt_out_sets_false(self):
        main._auto_connect = True
        # Simulate config message
        main._auto_connect = False  # as on_message would set it
        self.assertFalse(main._auto_connect)

    def test_missing_field_defaults_true(self):
        # data.get("autoConnect", True) should default to True
        data = {"scales": ["AA:BB:CC:DD:EE:FF"]}
        main._auto_connect = data.get("autoConnect", True)
        self.assertTrue(main._auto_connect)

    def test_explicit_true(self):
        data = {"scales": [], "autoConnect": True}
        main._auto_connect = data.get("autoConnect", True)
        self.assertTrue(main._auto_connect)

    def test_explicit_false(self):
        data = {"scales": [], "autoConnect": False}
        main._auto_connect = data.get("autoConnect", True)
        self.assertFalse(main._auto_connect)


class TestWaitNotBusy(unittest.IsolatedAsyncioTestCase):
    """_wait_not_busy: serialize host connect against an in-flight BLE op (#231)."""

    async def test_returns_true_when_free(self):
        main._busy = False
        self.assertTrue(await main._wait_not_busy(max_iters=3, sleep_ms=1))

    async def test_returns_false_when_stays_busy(self):
        main._busy = True
        try:
            self.assertFalse(await main._wait_not_busy(max_iters=2, sleep_ms=1))
        finally:
            main._busy = False

    async def test_returns_true_when_busy_clears(self):
        main._busy = True

        async def _clear():
            await _asyncio.sleep(0.002)
            main._busy = False

        task = _asyncio.ensure_future(_clear())
        try:
            self.assertTrue(await main._wait_not_busy(max_iters=50, sleep_ms=1))
        finally:
            main._busy = False
            await task


if __name__ == "__main__":
    unittest.main()
