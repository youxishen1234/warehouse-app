"""Exercise calibration acceptance on any host; UIKit is tested separately in CI."""

import importlib.util
import math
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("label_font_ios", ROOT / "scripts/test-label-font-ios.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)

TEXT = "校准 中文 成品 纸板 × g/m²"
ROWS = ["校准样张", "中文：纸板纸箱成品", "符号：× ÷ ± g/m²", "纸张 70 × 100 mm"]


def build(width_mm=70, rows=None):
    rows = list(ROWS if rows is None else rows)
    content = width_mm - 6
    height = 90
    lines = [
        {"type": "line", "x": 3, "y": 5, "w": content, "h": 0.6},
        {"type": "line", "x": 3, "y": 5 + height - 0.6, "w": content, "h": 0.6},
        {"type": "line", "x": 3, "y": 5, "w": 0.6, "h": height},
        {"type": "line", "x": 3 + content - 0.6, "y": 5, "w": 0.6, "h": height},
    ]
    images, evidence, y = [], [], 30
    for offset, row in enumerate(rows):
        images.append({"type": "image", "x": 3, "y": y, "w": content, "h": 6.84,
                       "sourceField": "校准文字", "sourceText": row})
        evidence.append({
            "index": 4 + offset, "sourceText": row, "w": content, "h": 6.84,
            "widthPx": math.ceil(content * 300 / 25.4),
            "heightPx": math.ceil(6.84 * 300 / 25.4),
            "inkPixelsBelow127": 1200, "edgeInkPixelsBelow127": 0,
            "png": "render-calibration-%d.png" % (4 + offset),
        })
        y += 6.84
    report = {"schemaVersion": 2, "expectedText": TEXT, "dpi": 300,
              "contentWidthMm": content, "contentHeightMm": height,
              "lineElements": 4, "textElements": len(images),
              "fitId": "calibration", "images": evidence}
    return lines + images, report


class CalibrationValidatorTests(unittest.TestCase):
    def setUp(self):
        self.profile = {"widthMm": 70, "heightMm": 100,
                        "marginMm": {"left": 3, "right": 3, "top": 5, "bottom": 5}}
        self.elements, self.evidence = build()

    def validate(self):
        RUNNER.validate_calibration_evidence(self.evidence, self.elements, TEXT, self.profile)

    def test_accepts_border_and_per_row_text(self):
        self.validate()

    def test_accepts_wrapped_narrow_calibration(self):
        self.profile["widthMm"] = 40
        self.elements, self.evidence = build(40, [
            "校准样张", "中文：纸板纸", "箱成品", "符号：× ÷ ± g/m²", "纸张 40 × 100 mm"])
        self.validate()

    def test_rejects_single_full_page_bitmap(self):
        self.elements[4]["h"] = 90
        self.evidence["images"][0]["h"] = 90
        self.evidence["images"][0]["heightPx"] = math.ceil(90 * 300 / 25.4)
        with self.assertRaisesRegex(AssertionError, "full-page"):
            self.validate()

    def test_rejects_border_only(self):
        self.elements = [x for x in self.elements if x["type"] == "line"]
        self.evidence["images"] = []
        self.evidence["textElements"] = 0
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_blank_row(self):
        self.evidence["images"][0]["inkPixelsBelow127"] = 0
        with self.assertRaisesRegex(AssertionError, "blank"):
            self.validate()

    def test_rejects_clipped_row(self):
        self.evidence["images"][0]["edgeInkPixelsBelow127"] = 3
        with self.assertRaisesRegex(AssertionError, "clipped"):
            self.validate()

    def test_rejects_pixel_size_mismatch(self):
        self.evidence["images"][0]["widthPx"] += 1
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_missing_text_token(self):
        self.elements[4]["sourceText"] = "★"
        self.evidence["images"][0]["sourceText"] = "★"
        with self.assertRaisesRegex(AssertionError, "missing 校准"):
            self.validate()

    def test_rejects_changed_expected_text(self):
        self.evidence["expectedText"] = "校准"
        with self.assertRaisesRegex(AssertionError, "changed or omitted"):
            self.validate()

    def test_rejects_extra_border_line(self):
        self.elements.append({"type": "line", "x": 3, "y": 50, "w": 64, "h": 0.6})
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_unknown_element_type(self):
        self.elements.append({"type": "qr", "x": 3, "y": 50, "w": 10, "h": 10})
        with self.assertRaises(AssertionError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
