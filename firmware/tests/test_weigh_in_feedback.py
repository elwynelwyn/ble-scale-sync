"""Host-runnable tests for main.py's weigh-in sounds.

One short beep when a known scale reports a weight, and the problem sound when
the server's result beep does not follow within RESULT_TIMEOUT_MS. The pure
decisions are covered in test_scale_beep.py; these tests cover how main.py
wires them to the beeper, the display, the MQTT beep command and the watchdog.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import types
import unittest

from _main_loader import VALID_CONFIG, load_main

_MAC = "AA:BB:CC:DD:EE:FF"
_BEEP_TOPIC = b"test/test/beep"


def _frame_hex(weight_raw, status=0x01):
    body = bytes([0xCF, 0, 0, weight_raw & 0xFF, weight_raw >> 8, 0, 0, 0, 0, status])
    x = 0
    for b in body:
        x ^= b
    return (b"\xcc\xdd\xee\xff" + body + bytes([x]) + b"\x64\x91\x46").hex()


def _scale_entry(weight_raw):
    return {"address": _MAC, "manufacturer_id": 0xBBAA, "manufacturer_data": _frame_hex(weight_raw)}


class _Stop(BaseException):
    pass


class WeighInFeedbackTest(unittest.TestCase):
    def setUp(self):
        self.main = load_main(VALID_CONFIG, HAS_BEEP=True)
        self.beeps = []
        self.main.beep = lambda *a, **k: self.beeps.append(a)
        self.main._scale_macs = {_MAC}
        self.now = 100_000
        self.main.time = types.SimpleNamespace(ticks_ms=lambda: self.now)

    def _scan(self, weight_raw):
        self.main._check_scale_beep([_scale_entry(weight_raw)])

    def test_idle_wake_is_silent_and_arms_no_timer(self):
        self._scan(0)
        self.now += 60_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [])

    def test_weight_beeps_once_while_scale_keeps_advertising(self):
        self._scan(0)
        self._scan(7550)
        self._scan(7550)
        self._scan(7540)
        self.assertEqual(self.beeps, [()])

    def test_unknown_scale_is_silent(self):
        self.main._scale_macs = set()
        self._scan(7550)
        self.now += 60_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [])

    def test_no_result_beep_plays_problem_sound(self):
        self._scan(7550)
        self.beeps.clear()
        self.now += 14_999
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [])
        self.now += 1
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [(400, 500, 2)])
        self.now += 60_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [(400, 500, 2)])

    def test_server_beep_cancels_problem_sound(self):
        self._scan(7550)
        self.beeps.clear()
        self.now += 10_000
        self.main.on_message(_BEEP_TOPIC, b'{"freq": 1200, "duration": 200, "repeat": 2}', False)
        self.now += 60_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [])

    def test_any_server_beep_pattern_cancels(self):
        self._scan(7550)
        self.main.on_message(_BEEP_TOPIC, b'{"freq": 600, "duration": 150, "repeat": 3}', False)
        self.assertIsNone(self.main._result_timer.started)

    def test_server_beep_before_start_beep_silences_the_weigh_in(self):
        self.main.on_message(_BEEP_TOPIC, b"", False)
        self._scan(7550)
        self._scan(7550)
        self.assertEqual(self.beeps, [])
        self.assertIsNone(self.main._result_timer.started)

    def test_server_beep_then_zero_weight_rearms(self):
        self.main.on_message(_BEEP_TOPIC, b"", False)
        self._scan(0)
        self._scan(7550)
        self.assertEqual(self.beeps, [()])

    def test_server_beep_then_long_silence_rearms(self):
        self.main.on_message(_BEEP_TOPIC, b"", False)
        self.now += 30_000
        self.main._check_scale_beep([])
        self._scan(7550)
        self.assertEqual(self.beeps, [()])

    def test_resume_scanning_refreshes_rearm_window(self):
        self._scan(7550)
        self.beeps.clear()
        self.now += 29_000
        self.main._resume_scanning()
        self.now += 29_000
        self._scan(7550)
        self.assertEqual(self.beeps, [])

    def test_without_resume_the_same_gap_rearms(self):
        self._scan(7550)
        self.beeps.clear()
        self.now += 58_000
        self._scan(7550)
        self.assertEqual(self.beeps, [()])

    def test_other_commands_do_not_cancel(self):
        self._scan(7550)
        self.main.on_message(b"test/test/disconnect", b"", False)
        self.assertIsNotNone(self.main._result_timer.started)

    def test_new_weigh_in_after_problem_sound_arms_timer_again(self):
        self._scan(7550)
        self.now += 40_000
        self.main._check_result_timeout()
        self._scan(0)
        self.beeps.clear()
        self._scan(6000)
        self.assertEqual(self.beeps, [()])
        self.now += 40_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps[-1], (400, 500, 2))

    def test_display_notified_on_start_beep(self):
        shown = []
        self.main.board.HAS_DISPLAY = True
        self.main.ui = types.SimpleNamespace(on_scale_detected=shown.append)
        self._scan(7550)
        self._scan(7550)
        self.assertEqual(shown, [_MAC])

    def test_no_timer_without_speaker(self):
        self.main.board.HAS_BEEP = False
        self._scan(7550)
        self.assertIsNone(self.main._result_timer.started)

    def _run_watchdog(self, iterations):
        async def sleep_ms(ms):
            self.now += ms
            sleeps.append(ms)
            if len(sleeps) >= iterations:
                raise _Stop()

        sleeps = []
        self.main.asyncio = types.SimpleNamespace(sleep_ms=sleep_ms)
        with self.assertRaises(_Stop):
            asyncio.run(self.main._result_watchdog())

    def test_watchdog_plays_problem_sound_for_a_wedged_session_at_the_hard_cap(self):
        self._scan(7550)
        self.main._scan_paused = True
        self.main._busy = True
        self.beeps.clear()
        self._run_watchdog(89)
        self.assertEqual(self.beeps, [])
        self._run_watchdog(2)
        self.assertEqual(self.beeps, [(400, 500, 2)])

    def test_connect_past_the_timeout_is_not_a_problem(self):
        self._scan(7550)
        self.beeps.clear()
        self.now += 1_000
        self.main._host_connect_pending = True
        self.now += 2_000
        self.main._host_connect_pending = False
        self.main._scan_paused = True
        self.now += 17_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [])

    def test_cue_right_after_the_session_cancels(self):
        self._scan(7550)
        self.beeps.clear()
        self.main._scan_paused = True
        self.now += 20_000
        self.main._check_result_timeout()
        self.main._resume_scanning()
        self.now += 1_000
        self.main._check_result_timeout()
        self.main.on_message(_BEEP_TOPIC, b'{"freq": 1200, "duration": 200, "repeat": 2}', False)
        self.now += 60_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [])

    def test_no_cue_after_the_session_plays_problem_sound_3s_later(self):
        self._scan(7550)
        self.beeps.clear()
        self.main._scan_paused = True
        self.now += 20_000
        self.main._resume_scanning()
        self.now += 2_999
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [])
        self.now += 1
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [(400, 500, 2)])

    def test_session_before_the_start_beep_does_not_extend_it(self):
        self.main._resume_scanning()
        self.now += 5_000
        self._scan(7550)
        self.beeps.clear()
        self.now += 15_000
        self.main._check_result_timeout()
        self.assertEqual(self.beeps, [(400, 500, 2)])

    def test_watchdog_survives_a_failing_beep(self):
        def broken_beep(*a, **k):
            raise OSError("i2s")

        self._scan(7550)
        self.main.beep = broken_beep
        self._run_watchdog(90)
        self.main.beep = lambda *a, **k: self.beeps.append(a)
        self.beeps.clear()
        self._scan(0)
        self._scan(7550)
        self.beeps.clear()
        self._run_watchdog(90)
        self.assertEqual(self.beeps, [(400, 500, 2)])


if __name__ == "__main__":
    unittest.main()
