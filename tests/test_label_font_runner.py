import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts/test-label-font-ios.py"
SPEC = importlib.util.spec_from_file_location("label_font_runner", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class LaunchRecoveryTests(unittest.TestCase):
    def test_retries_one_ambiguous_launch(self):
        calls = []

        def attempt():
            calls.append("attempt")
            if calls.count("attempt") == 1:
                raise runner.SimulatorLaunchTimeout("launch timeout")
            return "report"

        result = runner.with_launch_recovery(attempt, lambda: calls.append("recover"))
        self.assertEqual(result, "report")
        self.assertEqual(calls, ["attempt", "recover", "attempt"])

    def test_second_launch_timeout_still_fails(self):
        recoveries = []
        with self.assertRaises(runner.SimulatorLaunchTimeout):
            runner.with_launch_recovery(
                lambda: (_ for _ in ()).throw(runner.SimulatorLaunchTimeout("launch timeout")),
                lambda: recoveries.append(True),
            )
        self.assertEqual(recoveries, [True])

    def test_renderer_assertion_is_never_retried(self):
        recoveries = []
        with self.assertRaisesRegex(AssertionError, "Clipped text"):
            runner.with_launch_recovery(
                lambda: (_ for _ in ()).throw(AssertionError("Clipped text")),
                lambda: recoveries.append(True),
            )
        self.assertEqual(recoveries, [])

    def test_non_launch_failure_is_not_retried(self):
        recoveries = []
        with self.assertRaisesRegex(RuntimeError, "event handler crashed"):
            runner.with_launch_recovery(
                lambda: (_ for _ in ()).throw(RuntimeError("event handler crashed")),
                lambda: recoveries.append(True),
            )
        self.assertEqual(recoveries, [])

    def test_github_error_text_is_escaped(self):
        self.assertEqual(runner.github_escape("100%\r\nfailed"), "100%25%0D%0Afailed")


if __name__ == "__main__":
    unittest.main()
