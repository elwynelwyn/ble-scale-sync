"""Guards against CPython-only syntax that breaks on the MicroPython firmware.

MicroPython raises NotImplementedError ("only slices with step=1 (aka None)
are supported") for step slices such as b[::-1] on bytes, so firmware sources
must not use them.

Run: python -m unittest discover -s firmware/tests
"""

import ast
import glob
import os
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _step_slice_lines(source):
    return [
        getattr(node, "lineno", 0)
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Slice) and node.step is not None
    ]


class TestNoStepSlices(unittest.TestCase):
    def test_detector_flags_step_slices(self):
        for src in ("x[::-1]", "a[1:2:3]", "b[a:b:n]"):
            self.assertTrue(_step_slice_lines(src), src)

    def test_detector_ignores_plain_slices_and_colons(self):
        for src in ("x[1:-1]", "{'v': 2}", "f'{v:02x}'"):
            self.assertEqual(_step_slice_lines(src), [], src)

    def test_firmware_sources_have_no_step_slices(self):
        offenders = []
        for path in sorted(glob.glob(os.path.join(_FIRMWARE_DIR, "*.py"))):
            with open(path, encoding="utf-8") as f:
                source = f.read()
            for lineno in _step_slice_lines(source):
                offenders.append("%s:%d" % (os.path.basename(path), lineno))
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
