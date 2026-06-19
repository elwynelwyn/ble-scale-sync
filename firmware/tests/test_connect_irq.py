"""Host-runnable test: BleBridge.connect() restores aioble's IRQ handler (#231).

The streaming scan installs the firmware's own _ble.irq() handler on the shared
bluetooth.BLE() singleton. aioble registers its dispatcher only once at import
and never restores it, so connect() must hand the IRQ back to aioble before
calling device.connect(), or _IRQ_PERIPHERAL_CONNECT is dropped and the connect
times out.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)


class _MockBLE:
    def __init__(self):
        self.current_irq = None

    def active(self, value=None):
        return True

    def irq(self, handler):
        self.current_irq = handler

    def gap_scan(self, *args):
        pass


_mock_ble = _MockBLE()

_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: _mock_ble
_bt.FLAG_READ = 0x02
_bt.FLAG_WRITE = 0x08
_bt.FLAG_NOTIFY = 0x10
_bt.FLAG_WRITE_NO_RESPONSE = 0x04
_bt.FLAG_INDICATE = 0x20
sys.modules["bluetooth"] = _bt


# aioble dispatcher sentinel: connect() must install THIS on the BLE singleton.
def _aioble_ble_irq(event, data):  # noqa: ARG001
    return None


_captured = {}


class _FakeConn:
    async def services(self):
        return []

    async def disconnect(self):
        pass

    def is_connected(self):
        return True


class _FakeDevice:
    def __init__(self, addr_type, addr_bytes):
        self._addr_type = addr_type

    async def connect(self, timeout_ms=None, scan_duration_ms=None):
        # Snapshot which IRQ handler owns the singleton at connect time.
        _captured["irq_at_connect"] = _mock_ble.current_irq
        _captured["addr_type"] = self._addr_type
        return _FakeConn()


_aioble_core = types.ModuleType("aioble.core")
_aioble_core.ble_irq = _aioble_ble_irq

_aioble = types.ModuleType("aioble")
_aioble.core = _aioble_core
_aioble.ADDR_PUBLIC = 0
_aioble.ADDR_RANDOM = 1
_aioble.Device = _FakeDevice
sys.modules["aioble"] = _aioble
sys.modules["aioble.core"] = _aioble_core

_board = types.ModuleType("board")
_board.MAX_SCAN_ENTRIES = 500
_board.AGGRESSIVE_GC = False
_board.DEACTIVATE_BLE_AFTER_SCAN = False
_board.CONNECT_TIMEOUT_MS = 15000
_board.CONNECT_SCAN_MS = 15000
_board.CONNECT_RETRIES = 1
sys.modules["board"] = _board

# Another test module (test_auto_connect) stubs sys.modules["ble_bridge"] with a
# SimpleNamespace that has no connect(). When the whole suite is discovered in one
# process that stub may already be cached, so drop it to force a real import of the
# firmware module under the stubs installed above.
sys.modules.pop("ble_bridge", None)
import ble_bridge  # noqa: E402


class TestConnectRestoresAiobleIrq(unittest.IsolatedAsyncioTestCase):
    """connect() must reclaim the BLE IRQ for aioble after a streaming scan (#231)."""

    async def test_irq_restored_before_connect(self):
        _captured.clear()
        bridge = ble_bridge.BleBridge()

        # Streaming scan installs the firmware's scan-only handler, clobbering
        # aioble's dispatcher (the production bug's precondition).
        bridge.start_streaming()
        self.assertIsNot(_mock_ble.current_irq, _aioble_core.ble_irq)

        await bridge.connect("FF:03:00:53:D6:4D", 1)

        # By the time aioble's Device.connect() ran, aioble's dispatcher must own
        # the IRQ, otherwise _IRQ_PERIPHERAL_CONNECT is dropped and it times out.
        self.assertIs(_captured["irq_at_connect"], _aioble_core.ble_irq)
        self.assertEqual(_captured["addr_type"], 1)  # reported type (1) probed first

    async def test_public_scale_probes_reported_type_first(self):
        # Regression for #231: the QN-Scale advertises as public (addr_type=0).
        # connect() must probe the reported type (public=0) first, not force
        # random from the FF MAC bits, or it never matches the advertiser.
        _captured.clear()
        bridge = ble_bridge.BleBridge()
        bridge.start_streaming()
        await bridge.connect("FF:03:00:53:D6:4D", 0)
        self.assertEqual(_captured["addr_type"], 0)


if __name__ == "__main__":
    unittest.main()
