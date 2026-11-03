"""Host-runnable tests for the weigh-in beep logic in ble_bridge.

Covers advert_weight (0xCF frame parsing from manufacturer_data) and the
ScaleBeepGate state machine that decides when main.py beeps.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

sys.modules["aioble"] = types.ModuleType("aioble")
_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: None
sys.modules["bluetooth"] = _bt
sys.modules["board"] = types.ModuleType("board")

# test_auto_connect stubs sys.modules["ble_bridge"]; drop it to load the real module.
sys.modules.pop("ble_bridge", None)
import ble_bridge  # noqa: E402


# ─── helpers ─────────────────────────────────────────────────────────────────

_MAC = "AA:BB:CC:DD:EE:FF"
_OTHER_MAC = "11:22:33:44:55:66"

# Eufy T9146 manufacturer_data layout: MAC tail (4) | 0xCF frame (11) | battery | model id.
_MAC_TAIL = "ccddeeff"
_TRAILER = "649146"


def _frame(weight_raw, status=0x01, impedance=0):
    body = bytes([
        0xCF,
        impedance & 0xFF, impedance >> 8,
        weight_raw & 0xFF, weight_raw >> 8,
        0, 0, 0,
        0x00,
        status,
    ])
    x = 0
    for b in body:
        x ^= b
    return body + bytes([x])


def _entry(mfr_hex, mac=_MAC):
    return {"address": mac, "manufacturer_id": 0xBBAA, "manufacturer_data": mfr_hex}


def _weigh_entry(weight_raw, mac=_MAC, status=0x01):
    return _entry(_MAC_TAIL + _frame(weight_raw, status).hex() + _TRAILER, mac)


# ─── advert_weight ───────────────────────────────────────────────────────────


class TestAdvertWeight(unittest.TestCase):
    def test_frame_after_mac_tail(self):
        self.assertAlmostEqual(ble_bridge.advert_weight(_weigh_entry(7550)), 75.50)

    def test_corrupted_checksum(self):
        frame = bytearray(_frame(7550))
        frame[10] ^= 0x01
        bad = _MAC_TAIL + bytes(frame).hex() + _TRAILER
        self.assertIsNone(ble_bridge.advert_weight(_entry(bad)))

    def test_zero_weight(self):
        self.assertEqual(ble_bridge.advert_weight(_weigh_entry(0)), 0.0)

    def test_overload_status(self):
        self.assertIsNone(ble_bridge.advert_weight(_weigh_entry(7550, status=0x02)))

    def test_final_status(self):
        self.assertAlmostEqual(ble_bridge.advert_weight(_weigh_entry(7215, status=0x00)), 72.15)

    def test_missing_manufacturer_data(self):
        self.assertIsNone(ble_bridge.advert_weight({"address": _MAC}))

    def test_frame_at_other_offset(self):
        mfr = "aabb" + _frame(6000).hex()
        self.assertAlmostEqual(ble_bridge.advert_weight(_entry(mfr)), 60.0)

    def test_truncated_frame(self):
        self.assertIsNone(ble_bridge.advert_weight(_entry(_frame(6000).hex()[:-2])))


# ─── ScaleBeepGate ───────────────────────────────────────────────────────────


class TestScaleBeepGate(unittest.TestCase):
    def setUp(self):
        self.gate = ble_bridge.ScaleBeepGate()
        self.macs = {_MAC}

    def _update(self, results, now):
        return self.gate.update(results, self.macs, now)

    def test_idle_no_beep(self):
        self.assertIsNone(self._update([], 0))
        self.assertIsNone(self._update([], 60000))

    def test_first_non_zero_beeps_once(self):
        self.assertEqual(self._update([_weigh_entry(7550)], 0), (_MAC, 75.50))

    def test_repeated_non_zero_no_more_beeps(self):
        self._update([_weigh_entry(7550)], 0)
        for t in range(2000, 20000, 2000):
            self.assertIsNone(self._update([_weigh_entry(7550)], t))

    def test_zero_weight_rearms(self):
        self._update([_weigh_entry(7550)], 0)
        self.assertIsNone(self._update([_weigh_entry(0)], 2000))
        self.assertEqual(self._update([_weigh_entry(7000)], 4000), (_MAC, 70.0))

    def test_rearms_after_unseen_window(self):
        self._update([_weigh_entry(7550)], 0)
        self.assertIsNone(self._update([], 29999))
        self.assertIsNone(self._update([_weigh_entry(7550)], 29999))
        self.assertIsNone(self._update([], 59998))
        self.assertEqual(self._update([_weigh_entry(7550)], 59999), (_MAC, 75.50))

    def test_frameless_entries_never_beep(self):
        for t in range(0, 100000, 10000):
            self.assertIsNone(self._update([_entry("0102030405")], t))
            self.assertIsNone(self._update([{"address": _MAC}], t + 5000))

    def test_frameless_entry_counts_as_seen(self):
        self._update([_weigh_entry(7550)], 0)
        self.assertIsNone(self._update([{"address": _MAC}], 20000))
        self.assertIsNone(self._update([_weigh_entry(7550)], 40000))

    def test_unknown_mac_ignored(self):
        self.assertIsNone(self._update([_weigh_entry(7550, mac=_OTHER_MAC)], 0))


if __name__ == "__main__":
    unittest.main()
