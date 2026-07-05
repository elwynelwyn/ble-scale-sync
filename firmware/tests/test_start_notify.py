"""Host-runnable tests for BleBridge.start_notify / its notify loop.

start_notify must write the CCCD via aioble's char.subscribe(notify=True)
BEFORE consuming notified(): notified() alone only registers IRQ routing and
never writes the 0x2902 descriptor, so a spec-compliant peripheral (Eufy C1
T9146) never sends anything. The notify loop must also treat notified()
timeouts (asyncio.TimeoutError from aioble's DeviceTimeout) as "keep waiting"
— silence between weigh-ins is normal — instead of dying, because the
unexpected-disconnect relay lives in that loop's epilogue and a dead loop
means disconnects are never relayed to the host.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

# Stub MicroPython-only modules before importing ble_bridge (see
# test_ad_parser.py for the pattern). start_notify itself touches none of
# these, but ble_bridge imports them at module level.
sys.modules["aioble"] = types.ModuleType("aioble")
_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: None
sys.modules["bluetooth"] = _bt
sys.modules["board"] = types.ModuleType("board")

# Other test modules may have cached a different ble_bridge (or a stub of it);
# force a fresh import under the stubs installed above.
sys.modules.pop("ble_bridge", None)
import ble_bridge  # noqa: E402


_UUID = "0000fff100001000800000805f9b34fb"


class _DeviceDisconnectedError(Exception):
    """Stands in for aioble.DeviceDisconnectedError: raised by notified() when
    the peripheral drops. Must NOT be swallowed by the timeout handler."""


class _FakeConn:
    def __init__(self):
        self._connected = True

    def is_connected(self):
        return self._connected


class _FakeChar:
    """Records subscribe()/notified() calls in order and plays back a script.

    Script items: bytes (returned), exception instances (raised), or callables
    (invoked — may flip connection state and raise). When the script is
    exhausted, notified() parks forever so the test can cancel the loop task
    without a synthetic disconnect.
    """

    def __init__(self, script=None, subscribe_exc=None):
        self.calls = []  # ordered: ("subscribe", notify_kwarg) / ("notified",)
        self._script = list(script or [])
        self._subscribe_exc = subscribe_exc
        self._forever = asyncio.Event()

    async def subscribe(self, notify=True):
        self.calls.append(("subscribe", notify))
        if self._subscribe_exc is not None:
            raise self._subscribe_exc

    async def notified(self, timeout_ms=None):
        self.calls.append(("notified",))
        if self._script:
            item = self._script.pop(0)
            if callable(item):
                return item()
            if isinstance(item, BaseException):
                raise item
            return item
        await self._forever.wait()

    @property
    def subscribe_count(self):
        return sum(1 for c in self.calls if c[0] == "subscribe")

    @property
    def notified_count(self):
        return sum(1 for c in self.calls if c[0] == "notified")


def _make_bridge(conn, char):
    bridge = ble_bridge.BleBridge()
    bridge._conn = conn
    bridge._chars = {_UUID: char}
    return bridge


class TestStartNotifySubscribesCccd(unittest.IsolatedAsyncioTestCase):
    """start_notify must write the CCCD via subscribe(notify=True) exactly once,
    before the loop's first notified() wait."""

    async def test_subscribe_called_once_before_notified(self):
        conn = _FakeConn()
        published = []
        char = _FakeChar(script=[b"\x01\x02"])
        bridge = _make_bridge(conn, char)

        async def publish_fn(uuid_str, data):
            published.append((uuid_str, data))
            conn._connected = False  # end the loop after the first frame

        await bridge.start_notify(_UUID, publish_fn)
        self.assertEqual(len(bridge._notify_tasks), 1)
        await bridge._notify_tasks[0]

        self.assertEqual(char.subscribe_count, 1)
        self.assertEqual(char.calls[0], ("subscribe", True))  # CCCD write first
        self.assertGreaterEqual(char.notified_count, 1)
        self.assertEqual(published, [(_UUID, b"\x01\x02")])


class TestStartNotifyFailureSignalling(unittest.IsolatedAsyncioTestCase):
    """Unknown uuid / subscribe failure must raise (so main.py's command loop
    publishes the error topic) and must not leak a notify task."""

    async def test_subscribe_failure_raises_and_leaks_no_task(self):
        conn = _FakeConn()
        char = _FakeChar(subscribe_exc=ValueError("CCCD not found"))
        bridge = _make_bridge(conn, char)

        async def publish_fn(uuid_str, data):
            self.fail("publish_fn must not run when subscribe fails")

        with self.assertRaises(ValueError):
            await bridge.start_notify(_UUID, publish_fn)

        self.assertEqual(bridge._notify_tasks, [])
        self.assertEqual(char.notified_count, 0)

    async def test_unknown_uuid_raises_and_creates_no_task(self):
        bridge = ble_bridge.BleBridge()
        bridge._conn = _FakeConn()
        bridge._chars = {}

        async def publish_fn(uuid_str, data):
            self.fail("publish_fn must not run for an unknown uuid")

        with self.assertRaises(Exception):
            await bridge.start_notify("deadbeef00001000800000805f9b34fb", publish_fn)

        self.assertEqual(bridge._notify_tasks, [])


class TestNotifyLoopTimeoutIsNotFatal(unittest.IsolatedAsyncioTestCase):
    """notified() timing out means "still waiting" (aioble's DeviceTimeout
    raises asyncio.TimeoutError after timeout_ms of silence). The loop must
    continue — and must NOT fire the disconnect relay."""

    async def test_timeout_continues_and_later_data_still_published(self):
        conn = _FakeConn()
        published = []
        got_data = asyncio.Event()
        disconnect_fired = []

        char = _FakeChar(script=[asyncio.TimeoutError(), b"\xaa\xbb"])
        bridge = _make_bridge(conn, char)
        bridge.set_on_disconnect(lambda: disconnect_fired.append(1))

        async def publish_fn(uuid_str, data):
            published.append((uuid_str, data))
            got_data.set()

        await bridge.start_notify(_UUID, publish_fn)
        task = bridge._notify_tasks[0]

        await asyncio.wait_for(got_data.wait(), timeout=2)

        # The loop survived the timeout: notified() was consumed again and the
        # subsequent frame reached publish_fn.
        self.assertEqual(published, [(_UUID, b"\xaa\xbb")])
        self.assertGreaterEqual(char.notified_count, 2)
        self.assertFalse(task.done())  # still waiting, not dead

        # Explicit cancel (as bridge.disconnect() does) — the relay must not
        # fire for a timeout or a cancel while the peer is still connected.
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(disconnect_fired, [])


class TestNotifyLoopDisconnectRelay(unittest.IsolatedAsyncioTestCase):
    """A disconnect-like exception from notified() (peer gone, is_connected()
    False) must still reach the loop epilogue and fire the relay exactly once."""

    async def test_disconnect_exits_loop_and_fires_callback_once(self):
        conn = _FakeConn()
        disconnect_fired = []

        def _drop_and_raise():
            conn._connected = False
            raise _DeviceDisconnectedError("device disconnected")

        char = _FakeChar(script=[_drop_and_raise])
        bridge = _make_bridge(conn, char)
        bridge.set_on_disconnect(lambda: disconnect_fired.append(1))

        async def publish_fn(uuid_str, data):
            self.fail("publish_fn must not run on disconnect")

        await bridge.start_notify(_UUID, publish_fn)
        await asyncio.wait_for(bridge._notify_tasks[0], timeout=2)

        self.assertEqual(disconnect_fired, [1])
        self.assertTrue(bridge._disconnect_fired)


if __name__ == "__main__":
    unittest.main()
