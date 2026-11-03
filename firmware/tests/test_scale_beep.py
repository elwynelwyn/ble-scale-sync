"""Host-runnable tests for the weigh-in beep logic in ble_bridge.

Covers advert_weight (0xCF frame parsing from manufacturer_data), the
ScaleBeepGate state machine that decides when main.py beeps at the start of a
weigh-in, and the ResultTimer that decides when the problem sound plays.

Run: python -m unittest discover -s firmware/tests
"""

import importlib.util
import os
import sys
import types
import unittest
from unittest import mock

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: None
with mock.patch.dict(
    sys.modules,
    {"aioble": types.ModuleType("aioble"), "bluetooth": _bt, "board": types.ModuleType("board")},
):
    _spec = importlib.util.spec_from_file_location(
        "ble_bridge_scale_beep_under_test", os.path.join(_FIRMWARE_DIR, "ble_bridge.py")
    )
    ble_bridge = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(ble_bridge)


_MAC = "AA:BB:CC:DD:EE:FF"
_OTHER_MAC = "11:22:33:44:55:66"

# Manufacturer data layout: MAC tail (4) | 0xCF frame (11) | battery | model id.
_MAC_TAIL = "ccddeeff"
_TRAILER = "649146"

_TICKS_PERIOD = 1 << 30
_TICKS_MAX = _TICKS_PERIOD - 1
_TICKS_HALFPERIOD = _TICKS_PERIOD // 2


def _wrapping_ticks_diff(end, start):
    """ticks_diff with the semantics of MicroPython's ESP32 port."""
    return ((end - start + _TICKS_HALFPERIOD) & _TICKS_MAX) - _TICKS_HALFPERIOD


def _frame(weight_raw, status=0x01, impedance=0):
    body = bytes(
        [
            0xCF,
            impedance & 0xFF,
            impedance >> 8,
            weight_raw & 0xFF,
            weight_raw >> 8,
            0,
            0,
            0,
            0x00,
            status,
        ]
    )
    x = 0
    for b in body:
        x ^= b
    return body + bytes([x])


def _entry(mfr_hex, mac=_MAC):
    return {"address": mac, "manufacturer_id": 0xBBAA, "manufacturer_data": mfr_hex}


def _weigh_entry(weight_raw, mac=_MAC, status=0x01):
    return _entry(_MAC_TAIL + _frame(weight_raw, status).hex() + _TRAILER, mac)


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

    def test_all_zero_wake_data(self):
        self.assertIsNone(ble_bridge.advert_weight(_entry("00" * 18)))

    def test_overload_status(self):
        self.assertIsNone(ble_bridge.advert_weight(_weigh_entry(7550, status=0x02)))

    def test_final_status(self):
        self.assertAlmostEqual(ble_bridge.advert_weight(_weigh_entry(7215, status=0x00)), 72.15)

    def test_missing_manufacturer_data(self):
        self.assertIsNone(ble_bridge.advert_weight({"address": _MAC}))

    def test_invalid_hex(self):
        self.assertIsNone(ble_bridge.advert_weight(_entry("zz")))

    def test_frame_at_other_offset(self):
        mfr = "aabb" + _frame(6000).hex()
        self.assertAlmostEqual(ble_bridge.advert_weight(_entry(mfr)), 60.0)

    def test_truncated_frame(self):
        self.assertIsNone(ble_bridge.advert_weight(_entry(_frame(6000).hex()[:-2])))


class TestScaleBeepGate(unittest.TestCase):
    def setUp(self):
        self.gate = ble_bridge.ScaleBeepGate()
        self.macs = {_MAC}

    def _update(self, results, now):
        return self.gate.update(results, self.macs, now)

    def test_idle_no_beep(self):
        self.assertIsNone(self._update([], 0))
        self.assertIsNone(self._update([], 60000))

    def test_wake_with_zero_weight_is_silent(self):
        self.assertIsNone(self._update([_weigh_entry(0)], 0))
        self.assertIsNone(self._update([_entry("00" * 18)], 2000))

    def test_first_non_zero_beeps_once(self):
        self.assertEqual(self._update([_weigh_entry(7550)], 0), (_MAC, 75.50))

    def test_wake_then_weight_beeps_once(self):
        self.assertIsNone(self._update([_weigh_entry(0)], 0))
        self.assertEqual(self._update([_weigh_entry(3000)], 1000), (_MAC, 30.0))
        self.assertIsNone(self._update([_weigh_entry(7550)], 2000))

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

    def test_finish_disarms(self):
        self.gate.finish(0)
        self.assertIsNone(self._update([_weigh_entry(7550)], 1000))
        self.assertIsNone(self._update([_weigh_entry(7550)], 2000))

    def test_finish_then_zero_weight_rearms(self):
        self.gate.finish(0)
        self.assertIsNone(self._update([_weigh_entry(0)], 1000))
        self.assertEqual(self._update([_weigh_entry(7000)], 2000), (_MAC, 70.0))

    def test_finish_rearms_after_unseen_window_counted_from_finish(self):
        self.gate.finish(10000)
        self.assertIsNone(self._update([], 39999))
        self.assertIsNone(self._update([], 40000))
        self.assertEqual(self._update([_weigh_entry(7550)], 40001), (_MAC, 75.50))

    def test_finish_window_not_rearmed_before_30_seconds(self):
        self.gate.finish(10000)
        self.assertIsNone(self._update([], 39999))
        self.assertIsNone(self._update([_weigh_entry(7550)], 39999))

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

    def test_rearm_window_survives_tick_wrap(self):
        start = _TICKS_MAX - 10000
        with mock.patch.object(ble_bridge, "_ticks_diff", _wrapping_ticks_diff):
            self.assertIsNotNone(self._update([_weigh_entry(7550)], start))
            self.assertIsNone(self._update([_weigh_entry(7550)], (start + 20000) & _TICKS_MAX))
            self.assertIsNone(self._update([], (start + 49999) & _TICKS_MAX))
            self.assertIsNotNone(self._update([_weigh_entry(7550)], (start + 50000) & _TICKS_MAX))


class TestResultTimer(unittest.TestCase):
    def setUp(self):
        self.timer = ble_bridge.ResultTimer()

    def test_idle_before_start(self):
        self.assertFalse(self.timer.expired(0))
        self.assertFalse(self.timer.expired(10**6))

    def test_not_expired_before_timeout(self):
        self.timer.start(1000)
        self.assertFalse(self.timer.expired(1000))
        self.assertFalse(self.timer.expired(40999))

    def test_expired_at_timeout(self):
        self.timer.start(1000)
        self.assertTrue(self.timer.expired(41000))

    def test_expires_once(self):
        self.timer.start(0)
        self.assertTrue(self.timer.expired(45000))
        self.assertFalse(self.timer.expired(90000))

    def test_cancel_prevents_expiry(self):
        self.timer.start(0)
        self.timer.cancel()
        self.assertFalse(self.timer.expired(60000))

    def test_restart_resets_deadline(self):
        self.timer.start(0)
        self.timer.start(20000)
        self.assertFalse(self.timer.expired(45000))
        self.assertTrue(self.timer.expired(60000))

    def test_start_after_expiry_runs_again(self):
        self.timer.start(0)
        self.assertTrue(self.timer.expired(40000))
        self.timer.start(50000)
        self.assertFalse(self.timer.expired(60000))
        self.assertTrue(self.timer.expired(90000))

    def test_expiry_survives_tick_wrap(self):
        start = _TICKS_MAX - 10000
        with mock.patch.object(ble_bridge, "_ticks_diff", _wrapping_ticks_diff):
            self.timer.start(start)
            self.assertFalse(self.timer.expired((start + 39999) & _TICKS_MAX))
            self.assertTrue(self.timer.expired((start + 40000) & _TICKS_MAX))

    def test_elapsed_is_none_when_idle(self):
        self.assertIsNone(self.timer.elapsed(5000))

    def test_elapsed_since_start(self):
        self.timer.start(1000)
        self.assertEqual(self.timer.elapsed(4500), 3500)
        self.timer.cancel()
        self.assertIsNone(self.timer.elapsed(4500))


if __name__ == "__main__":
    unittest.main()
