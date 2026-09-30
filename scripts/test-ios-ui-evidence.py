"""Synthetic failure-detection tests; fixture success is not native acceptance."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image


SCRIPT = Path(__file__).with_name("verify-ios-ui-evidence.py")
SPEC = importlib.util.spec_from_file_location("ios_ui_evidence", SCRIPT)
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class EvidenceChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.attachments = self.root / "attachments"
        self.attachments.mkdir()
        self.source = self.root / "NativeDockInteractionTests.swift"
        self.methods = [VERIFIER.TAP_TEST]
        self.manifest = []
        self.make_fixture()

    def make_fixture(self, rotation=False):
        if rotation:
            self.methods.append(VERIFIER.ROTATION_TEST)
        self.source.write_text("final class NativeDockInteractionTests: XCTestCase {\n" +
                               "\n".join("func " + method + "() {}" for method in self.methods) + "\n}", encoding="utf-8")
        self.log = "\n".join("Test Case '-[NativeDockUITests.NativeDockInteractionTests " + method + "]' " + state
                             for method in self.methods for state in ("started.", "passed (1.000 seconds)."))
        self.log += "\nTest Suite 'NativeDockInteractionTests' passed at 2026-09-29 13:54:23.735.\n"
        self.log += " Executed {} tests, with 0 failures (0 unexpected) in 1 seconds\n** TEST EXECUTE SUCCEEDED **\n".format(len(self.methods))
        (self.root / "exit-status.txt").write_text("0\n", encoding="utf-8")
        self.manifest = []
        for method in self.methods:
            states = [("tap-tab-" + str(index), (12, 26)) for index in range(4)] if method == VERIFIER.TAP_TEST else [
                ("landscape-tap-tab-1", (26, 12)), ("landscape-tap-tab-3", (26, 12)), ("portrait-after-rotation-tab-0", (12, 26))]
            entries = []
            for state, dimensions in states:
                filename = state + ".png"
                Image.new("RGB", dimensions, "white").save(self.attachments / filename)
                entries.append({"exportedFileName": filename, "isAssociatedWithFailure": False,
                                "suggestedHumanReadableName": state + "_0_00000000-0000-0000-0000-000000000000.png"})
            self.manifest.append({"testIdentifier": "NativeDockInteractionTests/" + method + "()", "attachments": entries})
        self.save()

    def save(self):
        (self.root / "xcodebuild.log").write_text(self.log, encoding="utf-8")
        (self.attachments / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def verify(self):
        self.save()
        return VERIFIER.verify(self.root, self.source)

    def assert_failed(self, code):
        report = self.verify()
        self.assertEqual(report["status"], "failed")
        self.assertIn(code, [failure["code"] for failure in report["failures"]])
        return report

    def test_fixture_only_proves_evidence_contract(self):
        report = self.verify()
        self.assertEqual(report["status"], "evidence_complete")
        self.assertEqual(report["acceptance"]["production"], "not_assessed")
        self.assertEqual(report["acceptance"]["visual"], "not_assessed")
        self.assertEqual(len(report["requiredScreenshots"]), 4)
        self.assertEqual(report["inputs"]["expectedSource"]["sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())

    def test_new_source_cannot_accept_old_method_list(self):
        self.source.write_text(self.source.read_text()[:-1] + "func testRotateAndTapNativeTabs() {}\n}", encoding="utf-8")
        report = self.assert_failed("method_lifecycle")
        self.assertEqual(len(report["expectedMethods"]), 2)
        self.assertIn("required_screenshot", [item["code"] for item in report["failures"]])

    def test_missing_start_pass_and_retries_fail(self):
        original = self.log
        for changed in (original.replace("started.", "unknown."), original.replace("passed (1.000 seconds).", ""),
                        original + original.splitlines()[1] + "\n", original.replace("started.", "passed.", 1)):
            with self.subTest(log=changed):
                self.log = changed
                self.assert_failed("method_lifecycle")

    def test_skip_and_failure_fail_even_with_a_later_pass(self):
        original = self.log
        for state in ("skipped", "failed"):
            with self.subTest(state=state):
                self.log = original + "Test Case '-[OtherTests.OtherClass testOther]' " + state + " (1.0 seconds).\n"
                self.assert_failed("test_not_passed")

    def test_incomplete_run_summary_and_nonzero_exit_fail(self):
        original = self.log
        self.log = original.replace("** TEST EXECUTE SUCCEEDED **", "")
        self.assert_failed("run_completion")
        self.log = original.replace("Executed 1 tests", "Executed 0 tests")
        self.assert_failed("suite_summary")
        self.log = original
        (self.root / "exit-status.txt").write_text("65\n", encoding="utf-8")
        self.assert_failed("xcodebuild_exit")

    def test_manifest_missing_and_duplicate_methods_fail(self):
        self.manifest.append(copy.deepcopy(self.manifest[0]))
        self.assert_failed("manifest_methods")
        self.manifest.pop()
        self.manifest[0]["testIdentifier"] = "NativeDockInteractionTests/testOther()"
        self.assert_failed("manifest_methods")

    def test_unsafe_missing_and_directory_attachment_fail(self):
        attachment = self.manifest[0]["attachments"][0]
        for name in ("../outside.png", "..\\outside.png", "/outside.png", "C:\\outside.png", "image.png:stream", "trailing."):
            with self.subTest(name=name):
                attachment["exportedFileName"] = name
                self.assert_failed("unsafe_attachment_path")
        attachment["exportedFileName"] = "missing.png"
        self.assert_failed("missing_or_unsafe_attachment")
        (self.attachments / "directory.png").mkdir()
        attachment["exportedFileName"] = "directory.png"
        self.assert_failed("missing_or_unsafe_attachment")

    def test_failure_flag_duplicate_and_wrong_test_state_fail(self):
        attachment = self.manifest[0]["attachments"][0]
        attachment["isAssociatedWithFailure"] = True
        self.assert_failed("failure_attachment")
        del attachment["isAssociatedWithFailure"]
        self.assert_failed("failure_attachment")
        attachment["isAssociatedWithFailure"] = False
        self.manifest[0]["attachments"].append(copy.deepcopy(attachment))
        self.assert_failed("duplicate_attachment_file")
        self.manifest[0]["attachments"].pop()
        attachment["suggestedHumanReadableName"] = "tap-tab-01_0_00000000-0000-0000-0000-000000000000.png"
        self.assert_failed("required_screenshot")

    def test_missing_corrupt_and_wrong_format_png_fail(self):
        png = self.attachments / "tap-tab-0.png"
        original = png.read_bytes()
        for data in (b"not an image", original[:33], original[:-12]):
            with self.subTest(bytes=len(data)):
                png.write_bytes(data)
                self.assert_failed("invalid_png")
        Image.new("RGB", (12, 26)).save(png, format="JPEG")
        self.assert_failed("invalid_png")
        png.unlink()
        self.assert_failed("required_screenshot")

    def test_rotation_requires_landscape_and_portrait_pngs(self):
        self.make_fixture(rotation=True)
        self.assertEqual(self.verify()["status"], "evidence_complete")
        self.assertEqual(len(self.verify()["requiredScreenshots"]), 7)
        self.manifest[1]["attachments"].pop()
        self.assert_failed("required_screenshot")
        Image.new("RGB", (12, 26)).save(self.attachments / "landscape-tap-tab-1.png")
        self.assert_failed("screenshot_orientation")

    def test_source_comments_strings_and_other_classes_do_not_add_tests(self):
        self.source.write_text('''// func testFake() {}
/* nested /* func testFake2() {} */ comment */
class Other: XCTestCase { func testUnrelated() {} }
final class NativeDockInteractionTests: XCTestCase {
    let value = "func testString() {}"
    func testTapEveryNativeTab() {}
}
''', encoding="utf-8")
        self.assertEqual(self.verify()["expectedMethods"], [VERIFIER.TAP_TEST])
        self.assertEqual(self.verify()["status"], "evidence_complete")

    def test_screen_contract_rejects_old_app_only_evidence(self):
        self.make_fixture(rotation=True)
        report = VERIFIER.verify(self.root, self.source, require_screen_captures=True)
        self.assertEqual(report["status"], "failed")
        missing = [item["detail"] for item in report["failures"] if item["code"] == "required_screenshot"]
        self.assertTrue(any("screen-tap-tab-0" in detail for detail in missing))
        self.assertTrue(any("landscape-tap-tab-2" in detail for detail in missing))

    def test_screen_contract_requires_all_four_landscape_states(self):
        self.make_fixture(rotation=True)
        rotation = self.manifest[1]["attachments"]
        for index in [0, 2]:
            state = "landscape-tap-tab-" + str(index)
            entry = copy.deepcopy(rotation[0])
            entry["exportedFileName"] = state + ".png"
            entry["suggestedHumanReadableName"] = state + "_0_00000000-0000-0000-0000-000000000000.png"
            Image.new("RGB", (26, 12), "white").save(self.attachments / entry["exportedFileName"])
            rotation.append(entry)
        for method in self.manifest:
            for entry in list(method["attachments"]):
                screen = copy.deepcopy(entry)
                screen["exportedFileName"] = "screen-" + entry["exportedFileName"]
                screen["suggestedHumanReadableName"] = "screen-" + entry["suggestedHumanReadableName"]
                (self.attachments / screen["exportedFileName"]).write_bytes((self.attachments / entry["exportedFileName"]).read_bytes())
                method["attachments"].append(screen)
        self.save()
        report = VERIFIER.verify(self.root, self.source, require_screen_captures=True)
        self.assertEqual(report["status"], "evidence_complete")
        self.assertEqual(len(report["requiredScreenshots"]), 18)
        self.assertEqual(report["acceptance"]["visual"], "not_assessed")

    def test_cli_failure_is_nonzero_json_and_source_is_required(self):
        for extra in ([], ["--expected-source", str(self.source)]):
            (self.root / "exit-status.txt").write_text("65", encoding="utf-8")
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(self.root)] + extra,
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["status"], "failed")


if __name__ == "__main__":
    unittest.main()
