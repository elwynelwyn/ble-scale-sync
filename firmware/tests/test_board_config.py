"""Host-runnable tests for the per-board GATT connect tuning constants (#139).

The board_*.py modules are pure constants (no MicroPython-only imports), so they
import cleanly on a host. ble_bridge.connect() reads CONNECT_TIMEOUT_MS /
CONNECT_SCAN_MS / CONNECT_RETRIES from the active board, so every board module
must define them, and the no-PSRAM boards must use a tighter window + a retry.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import importlib
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

_ALL_BOARDS = [
    "board_atom_echo",
    "board_esp_wroom_32",
    "board_esp32_s3",
    "board_guition_4848",
]
_NO_PSRAM_BOARDS = ["board_atom_echo", "board_esp_wroom_32"]
_PSRAM_BOARDS = ["board_esp32_s3", "board_guition_4848"]


class TestBoardConnectConfig(unittest.TestCase):
    def _load(self, name):
        return importlib.import_module(name)

    def test_all_boards_define_connect_constants(self):
        for name in _ALL_BOARDS:
            mod = self._load(name)
            for const in ("CONNECT_TIMEOUT_MS", "CONNECT_SCAN_MS", "CONNECT_RETRIES"):
                self.assertTrue(hasattr(mod, const), f"{name} missing {const}")
                value = getattr(mod, const)
                self.assertIsInstance(value, int, f"{name}.{const} must be int")
                self.assertGreater(value, 0, f"{name}.{const} must be positive")

    def test_no_psram_boards_use_tighter_window_and_retry(self):
        s3_scan = self._load("board_esp32_s3").CONNECT_SCAN_MS
        for name in _NO_PSRAM_BOARDS:
            mod = self._load(name)
            self.assertGreaterEqual(
                mod.CONNECT_RETRIES, 2, f"{name} should retry on tight RAM"
            )
            self.assertLessEqual(
                mod.CONNECT_SCAN_MS, s3_scan, f"{name} window should be <= the S3 window"
            )

    def test_psram_boards_keep_single_long_window(self):
        for name in _PSRAM_BOARDS:
            mod = self._load(name)
            self.assertEqual(mod.CONNECT_RETRIES, 1, f"{name} should not need retries")
            self.assertEqual(mod.CONNECT_SCAN_MS, 15000, f"{name} keeps the 15s window")

    def test_all_boards_define_idf_heap_tunables_default_zero(self):
        for name in _ALL_BOARDS:
            mod = self._load(name)
            for const in ("CONNECT_MIN_IDF_LARGEST", "CONNECT_MIN_IDF_FREE"):
                self.assertTrue(hasattr(mod, const), f"{name} missing {const}")
                value = getattr(mod, const)
                self.assertIsInstance(value, int, f"{name}.{const} must be int")
                self.assertGreaterEqual(value, 0, f"{name}.{const} must be >= 0")


if __name__ == "__main__":
    unittest.main()
