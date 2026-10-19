"""Exercise calibration acceptance on any host; UIKit is tested separately in CI."""

import copy
import importlib.util
import math
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("label_font_ios", ROOT / "scripts/test-label-font-ios.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class CalibrationValidatorTests(unittest.TestCase):
    def setUp(self):
        self.text = "校准 中文 成品 纸板 × g/m²"
        self.profile = {"widthMm": 70, "heightMm": 100,
                        "marginMm": {"left": 3, "right": 3, "top": 5, "bottom": 5}}
        self.element = {"type": "image", "sourceField": "校准样张", "sourceText": self.text,
                        "x": 3, "y": 5, "w": 64, "h": 90}
        # Synthetic report statistics intentionally do not impersonate native
        # evidence. These fixtures test the acceptance function, not font output.
        self.evidence = {
            "schemaVersion": 1, "expectedText": self.text, "fontMm": 4.0, "dpi": 300,
            "widthPx": math.ceil(64 * 300 / 25.4), "heightPx": math.ceil(90 * 300 / 25.4),
            "excludedBorderPx": math.ceil(300 / 25.4) + 2,
            "referencePNG": "reference-calibration-layout-calibration-original.png",
            "expectedInkPixels": 1200, "actualInteriorInkPixels": 1200,
            "missingInkPixels": 0, "extraInteriorInkPixels": 0,
            "expectedBoundsPx": [40, 60, 500, 44], "actualBoundsPx": [40, 60, 500, 44],
            "lines": [{"index": 0, "text": self.text, "expectedInkPixels": 1200,
                       "expectedBoundsPx": [40, 60, 500, 44], "missingInkPixels": 0}],
        }

    def validate(self):
        RUNNER.validate_calibration_evidence(self.evidence, self.element, self.text, self.profile)

    def test_accepts_complete_correctly_placed_text(self):
        self.validate()

    def test_accepts_small_threshold_antialias_variation(self):
        self.evidence["actualInteriorInkPixels"] = 1190
        self.evidence["missingInkPixels"] = 10
        self.evidence["lines"][0]["missingInkPixels"] = 10
        self.evidence["actualBoundsPx"][0] += 1
        self.validate()

    def test_accepts_independent_wrapped_line_evidence(self):
        self.profile["widthMm"] = 40
        self.element["w"] = 34
        self.evidence["widthPx"] = math.ceil(34 * 300 / 25.4)
        self.evidence["expectedBoundsPx"] = [40, 60, 260, 130]
        self.evidence["actualBoundsPx"] = [40, 60, 260, 130]
        self.evidence["lines"] = [
            {"index": 0, "text": self.text[:8], "expectedInkPixels": 600,
             "expectedBoundsPx": [40, 60, 260, 44], "missingInkPixels": 0},
            {"index": 1, "text": self.text[8:], "expectedInkPixels": 600,
             "expectedBoundsPx": [40, 146, 220, 44], "missingInkPixels": 0},
        ]
        self.validate()

    def test_rejects_border_only_bitmap(self):
        self.evidence["actualInteriorInkPixels"] = 0
        self.evidence["actualBoundsPx"] = []
        self.evidence["missingInkPixels"] = 1200
        self.evidence["lines"][0]["missingInkPixels"] = 1200
        with self.assertRaisesRegex(AssertionError, "only its border"):
            self.validate()

    def test_rejects_unscaled_points_as_pixels(self):
        # 72/300 of the expected physical size: the original calibration bug.
        self.evidence["actualBoundsPx"] = [9, 0, 120, 11]
        self.evidence["actualInteriorInkPixels"] = 69
        self.evidence["missingInkPixels"] = 1200
        self.evidence["extraInteriorInkPixels"] = 69
        with self.assertRaisesRegex(AssertionError, "ink area changed"):
            self.validate()

    def test_rejects_wrong_baseline_with_same_ink_area(self):
        self.evidence["actualBoundsPx"][1] += 40
        self.evidence["missingInkPixels"] = 1100
        self.evidence["extraInteriorInkPixels"] = 1100
        with self.assertRaisesRegex(AssertionError, "missing, clipped, or misplaced"):
            self.validate()

    def test_rejects_wrong_bbox_even_if_ink_counters_match(self):
        self.evidence["actualBoundsPx"][1] += 40
        with self.assertRaisesRegex(AssertionError, "bounds differ"):
            self.validate()

    def test_keeps_short_wrapped_line_subject_to_line_tolerance(self):
        self.evidence["lines"] = [
            {"index": 0, "text": self.text[:-1], "expectedInkPixels": 1190,
             "expectedBoundsPx": [40, 60, 500, 44], "missingInkPixels": 0},
            {"index": 1, "text": self.text[-1:], "expectedInkPixels": 10,
             "expectedBoundsPx": [40, 146, 10, 20], "missingInkPixels": 10},
        ]
        self.evidence["actualInteriorInkPixels"] = 1190
        self.evidence["missingInkPixels"] = 10
        with self.assertRaisesRegex(AssertionError, "line is missing or clipped"):
            self.validate()

    def test_rejects_removed_source_text(self):
        del self.element["sourceText"]
        with self.assertRaises(KeyError):
            self.validate()

    def test_rejects_changed_source_text(self):
        self.element["sourceText"] = "校准"
        with self.assertRaisesRegex(AssertionError, "text was changed or omitted"):
            self.validate()

    def test_rejects_displaced_image(self):
        self.element["y"] = 0
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_changed_font_size(self):
        self.evidence["fontMm"] = 0.96
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_missing_line_source_text(self):
        self.evidence["lines"][0]["text"] = "校准"
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_border_exclusion_hiding_misplaced_text(self):
        self.evidence["excludedBorderPx"] = 200
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_negative_difference_counters(self):
        self.evidence["missingInkPixels"] = -1
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_empty_reference(self):
        self.evidence["expectedInkPixels"] = 0
        with self.assertRaisesRegex(AssertionError, "reference is blank"):
            self.validate()

    def test_rejects_duplicated_line_evidence(self):
        self.evidence["lines"].append(copy.deepcopy(self.evidence["lines"][0]))
        with self.assertRaises(AssertionError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
