"""Exercise the checked-in renderer on iOS, without submitting to JCAPI or business APIs."""

import argparse
import hashlib
import json
import math
import os
import pathlib
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests/label-font-fixtures.json"
HARNESS = ROOT / "tests/label-font-ios-harness.swift"
RENDERER = ROOT / "ios/App/App/LabelTemplateRenderer.swift"


def validate_fixtures(fixtures):
    assert fixtures["schemaVersion"] == 1 and fixtures["testOnly"] is True
    profile = fixtures["screenshotProfile"]
    assert (profile["widthMm"], profile["heightMm"], profile["density"], profile["paperStyle"]) == (70, 100, 3, "gap")
    assert profile["marginMm"] == {"top": 5, "right": 3, "bottom": 5, "left": 3}
    assert profile["calibrated"] is False
    assert fixtures["calibrationOriginalText"] == "\u6821\u51c6 \u4e2d\u6587 \u6210\u54c1 \u7eb8\u677f \u00d7 g/m\u00b2"
    cases = fixtures["textCases"]
    assert len(cases) == 12 and len({x["id"] for x in cases}) == len(cases)
    assert cases[0]["text"] == fixtures["calibrationOriginalText"] and cases[0]["fontMm"] == 3
    assert {x["text"] for x in cases if x.get("negative")} == {"\u0378", "\U0010ffff"}
    assert next(x for x in cases if x["id"] == "combining-marks")["text"] == "Cafe\u0301 / A\u030a"
    for case in cases:
        assert case["text"] and 0 < case["fontMm"] < 20
        assert 0 < case["widthMm"] <= 120 and 0 < case["heightMm"] <= 200
        assert case["id"].replace("-", "").isalnum()
    templates = fixtures["templateCases"]
    assert {x["kind"] for x in templates} == {"finished-product", "paperboard-batch"}
    assert all(x["templateVersion"] == 1 for x in templates)
    return fixtures


def validate_calibration_evidence(evidence, elements, text, profile):
    """Require four border images plus visible per-row text images.

    NIIMBOT rejects both one full-page calibration bitmap and its line primitive,
    so calibration must use only DrawLableImage: four thin border strips and one
    small text image per row. A border alone is never proof that text survived.
    """
    assert evidence["schemaVersion"] == 2
    assert evidence["expectedText"] == text, "Calibration text was changed or omitted"
    width = profile["widthMm"] - profile["marginMm"]["left"] - profile["marginMm"]["right"]
    height = profile["heightMm"] - profile["marginMm"]["top"] - profile["marginMm"]["bottom"]
    assert evidence["dpi"] == 300
    assert evidence["contentWidthMm"] == width and evidence["contentHeightMm"] == height
    assert all(x.get("type") == "image" for x in elements), "Calibration must use only image elements"
    border = [x for x in elements if x.get("sourceField", "").startswith("校准边框")]
    images = [x for x in elements if x.get("sourceField") == "校准文字"]
    assert len(border) == 4 and evidence["borderImages"] == 4, \
        "Calibration border must be four image strips"
    assert len(images) >= 3 and evidence["textElements"] == len(images)
    assert len(elements) == len(border) + len(images), "Calibration must not submit other element types"
    for element in border:
        assert element["sourceText"] and min(element["w"], element["h"]) <= 1.5
        assert element["w"] <= width and element["h"] <= height, "Calibration border is too large"
    for element in images:
        assert element["sourceText"] and element["h"] <= 12 and element["w"] <= width
    for item in evidence["images"]:
        index = item["index"]
        assert 0 <= index < len(elements) and elements[index]["type"] == "image"
        assert item["sourceText"] == elements[index]["sourceText"]
        assert item["widthPx"] == math.ceil(item["w"] * 300 / 25.4)
        assert item["heightPx"] == math.ceil(item["h"] * 300 / 25.4)
        assert item["inkPixelsBelow127"] > 20, "Calibration image row is blank"
        if item.get("sourceField") == "校准文字":
            assert item["edgeInkPixelsBelow127"] == 0, "Calibration text row is clipped"
        assert item["w"] * item["h"] < width * height * 0.5, "Calibration must not become one full-page bitmap"
    joined = "".join(item["sourceText"] for item in evidence["images"]
                      if item.get("sourceField") == "校准文字")
    for token in ("校准", "中文", "成品", "纸板", "×", "g/m²"):
        assert token in joined, "Calibration text is missing " + token


def validate_report(report, fixtures):
    assert report["status"] == "completed", report
    results = {x["id"]: x for x in report["textResults"]}
    assert set(results) == {x["id"] for x in fixtures["textCases"]}
    for case in fixtures["textCases"]:
        result = results[case["id"]]
        assert result["text"] == case["text"]
        assert "".join(x["character"] for x in result["graphemes"]) == case["text"]
        runs = result["fullLineFallbackRuns"]
        assert runs and all(x["resolvedFont"] for x in runs)
        preview = result["referencePreview"]
        assert preview["opaqueGrayscale"] is True and preview["dpiIntermediate"] == 300
        if not case.get("invisible"):
            assert preview["inkPixelsBelow127"] > 0, "Blank reference PNG: " + case["id"]
        if case.get("negative"):
            assert any(x["lastResort"] or 0 in x["glyphIDs"] for x in runs), "Negative control unexpectedly appears covered"
    attempts = {x["id"]: x for x in report["productionAttempts"]}
    assert set(attempts) == {"calibration-original"} | {x["id"] for x in fixtures["templateCases"]}
    assert all(x["outcome"] != "unexpected-error" for x in attempts.values())
    original = results["calibration-original"]
    calibration = attempts["calibration-original"]
    def validate_bitmap(bitmap, width, height, invisible=False, allow_border=False):
        assert bitmap["widthPx"] == math.ceil(width * 300 / 25.4)
        assert bitmap["heightPx"] == math.ceil(height * 300 / 25.4)
        assert bitmap["grayscale"] and bitmap["alphaInfo"] == 0 and bitmap["bitsPerPixel"] == 8
        if not allow_border:
            assert bitmap["edgeInkPixelsBelow127"] == 0, "Clipped text: " + bitmap["png"]
        assert (bitmap["inkPixelsBelow127"] == 0) if invisible else (bitmap["inkPixelsBelow127"] > 0)

    snapshots = {x["id"]: x for x in report["parsedSnapshots"]}
    for attempt in attempts.values():
        assert attempt["outcome"] == "passed-font-and-layout-to-sdk-stub", attempt
        assert attempt["sdkStubCalls"] == 1
        assert all(x["type"] in ("image", "line", "qr") for x in attempt["elements"])
        for element in attempt["elements"]:
            assert element["x"] >= 3 and element["y"] >= 5
            assert element["x"] + element["w"] <= 67.000001 and element["y"] + element["h"] <= 95.000001
            if element["type"] == "image":
                validate_bitmap(element["bitmap"], element["w"], element["h"],
                                allow_border=attempt["id"] == "calibration-original")
    assert len(calibration["elements"]) >= 7
    assert {x["type"] for x in calibration["elements"]} == {"image"}
    validate_calibration_evidence(calibration["calibrationEvidence"], calibration["elements"],
                                  fixtures["calibrationOriginalText"], fixtures["screenshotProfile"])
    calibration_regressions = {item["id"]: item for item in report["calibrationRegressions"]}
    assert set(calibration_regressions) == {"calibration-wrapped"}
    for item in calibration_regressions.values():
        assert item["outcome"] == "passed-font-and-layout-to-sdk-stub" and item["sdkStubCalls"] == 1, item
        assert len(item["elements"]) >= 7
        validate_calibration_evidence(item["calibrationEvidence"], item["elements"],
                                      fixtures["calibrationOriginalText"], item["profile"])
        assert item["calibrationEvidence"]["textElements"] > 4, "Narrow calibration must exercise wrapping"
    for case in fixtures["templateCases"]:
        text = "\n".join(x["text"] for x in snapshots[case["id"]]["fields"])
        assert all(token in text for token in case["expectedTextTokens"]), "Parsed snapshot dropped fixture data"
        elements = attempts[case["id"]]["elements"]
        for field in snapshots[case["id"]]["fields"]:
            assert "".join(x["sourceText"] for x in elements if x.get("sourceField") == field["field"]) == field["text"]
        qr = [x for x in elements if x["type"] == "qr"]
        assert len(qr) == 1 and qr[0]["text"] == case["data"].get("productUrl", case["data"].get("batchUrl"))
    regressions = {x["id"]: x for x in report["rendererRegressions"]}
    assert len(regressions) == len(fixtures["textCases"]) + 3
    expected_errors = {"color-emoji": "FONT_COLOR_UNSUPPORTED", "unassigned-negative": "FONT_GLYPH_MISSING",
                       "noncharacter-negative": "FONT_GLYPH_MISSING", "overflow-negative": "LAYOUT_OVERFLOW"}
    for id, result in regressions.items():
        if id in expected_errors:
            assert result["outcome"] == "rejected" and result["errorCode"] == expected_errors[id], result
        else:
            assert result["outcome"] == "rasterized", result
            assert "".join(x["sourceText"] for x in result["bitmaps"]) == result["text"]
            for bitmap in result["bitmaps"]:
                validate_bitmap(bitmap, bitmap["w"], bitmap["h"], invisible=id == "space-only")
    assert len(regressions["long-wrapping"]["bitmaps"]) > 1
    assert report["clippingNegative"]["errorCode"] == "LAYOUT_OVERFLOW" and report["clippingNegative"]["sdkStubCalls"] == 0
    return {
        "status": "renderer-regressions-passed-sdk-and-paper-not-tested",
        "nativeTextCases": len(results),
        "productionRendererAttempts": len(attempts),
        "calibrationLayoutRegressions": 1 + len(calibration_regressions),
        "rendererRegressions": len(regressions),
        "calibrationResult": {key: calibration[key] for key in ("id", "outcome", "sdkStubCalls")},
        "templateResults": [{key: x[key] for key in ("id", "outcome", "sdkStubCalls")} for x in attempts.values()],
        "calibrationBaseUnmappedGraphemes": [
            {"character": x["character"], "unicodeScalars": x["unicodeScalars"]}
            for x in original["graphemes"] if not x["baseFontDirectMapping"]
        ],
        "calibrationFullLineRuns": original["fullLineFallbackRuns"],
        "sdkTestDouble": True,
        "businessWrites": 0,
        "physicalPrintingTested": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate-fixtures", action="store_true", help="Validate data only; does not run UIKit")
    args = parser.parse_args()
    fixtures = validate_fixtures(json.loads(FIXTURES.read_text(encoding="utf-8")))
    if args.validate_fixtures:
        print("PASS: 12 text fixtures and 2 template fixtures. Native UIKit test NOT EXECUTED.")
        return
    if platform.system() != "Darwin":
        raise SystemExit("Native test NOT EXECUTED: macOS, Xcode and an iOS Simulator runtime are required.")

    output = pathlib.Path(os.environ.get("LABEL_FONT_OUTPUT_DIR", str(ROOT / "release/label-font-ios"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    release = ROOT / "release"
    release.mkdir(exist_ok=True)
    metadata = {
        "commit": os.environ.get("GITHUB_SHA"),
        "rendererSHA256": hashlib.sha256(RENDERER.read_bytes()).hexdigest(),
        "adapterSHA256": hashlib.sha256((ROOT / "ios/App/App/NIIMBOTSDKAdapter.m").read_bytes()).hexdigest(),
        "harnessSHA256": hashlib.sha256(HARNESS.read_bytes()).hexdigest(),
        "fixturesSHA256": hashlib.sha256(FIXTURES.read_bytes()).hexdigest(),
        "hostArch": platform.machine(), "sdkTestDouble": True, "physicalPrintingTested": False,
    }
    log = output / "runner.log"
    udid = None

    def run(*command, timeout=180, check=True):
        command = [str(x) for x in command]
        with log.open("a", encoding="utf-8") as handle:
            handle.write("$ " + " ".join(command) + "\n")
        result = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout)
        with log.open("a", encoding="utf-8") as handle:
            handle.write(result.stdout + "\n")
        if check and result.returncode:
            print(result.stdout[-16000:])
            raise RuntimeError("Command failed: " + " ".join(command[:4]))
        return result.stdout.strip()

    try:
        metadata["xcode"] = run("xcodebuild", "-version")
        runtimes = json.loads(run("xcrun", "simctl", "list", "runtimes", "-j"))["runtimes"]
        available = [x for x in runtimes if x.get("isAvailable") and "SimRuntime.iOS-" in x.get("identifier", "")
                     and int(x.get("version", "0").split(".")[0]) >= 26]
        if not available:
            run("xcodebuild", "-downloadPlatform", "iOS", timeout=1500)
            runtimes = json.loads(run("xcrun", "simctl", "list", "runtimes", "-j"))["runtimes"]
            available = [x for x in runtimes if x.get("isAvailable") and "SimRuntime.iOS-" in x.get("identifier", "")
                         and int(x.get("version", "0").split(".")[0]) >= 26]
        assert available, "No available iOS 26+ runtime"
        runtime = max(available, key=lambda x: tuple(int(y) for y in x["version"].split(".")))
        types = json.loads(run("xcrun", "simctl", "list", "devicetypes", "-j"))["devicetypes"]
        device = next((x for x in types if x["identifier"].endswith(".iPhone-16")), None)
        if device is None:
            device = next(x for x in types if x["name"].startswith("iPhone"))
        metadata["runtime"] = runtime
        metadata["deviceType"] = device
        sdk = run("xcrun", "--sdk", "iphonesimulator", "--show-sdk-path")
        metadata["sdk"] = sdk
        with tempfile.TemporaryDirectory(prefix="label-font-native-", dir=release) as folder:
            stage = pathlib.Path(folder)
            app = stage / "FontDiagnostic.app"
            app.mkdir()
            bundle = "com.warehouse.fontdiagnostic"
            info = {
                "CFBundleExecutable": "FontDiagnostic", "CFBundleIdentifier": bundle,
                "CFBundleName": "FontDiagnostic", "CFBundlePackageType": "APPL",
                "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0",
                "MinimumOSVersion": "18.0", "LSRequiresIPhoneOS": True,
                "UIDeviceFamily": [1, 2], "UILaunchScreen": {},
            }
            with (app / "Info.plist").open("wb") as handle:
                plistlib.dump(info, handle)
            shutil.copy2(FIXTURES, app / "fixtures.json")
            shutil.copy2(FIXTURES, output / "fixtures.json")
            shutil.copy2(HARNESS, output / "diagnostic-harness.swift")
            shutil.copy2(HARNESS, stage / "main.swift")
            arch = "arm64" if platform.machine() == "arm64" else "x86_64"
            run("xcrun", "--sdk", "iphonesimulator", "swiftc", "-swift-version", "5", "-sdk", sdk,
                "-target", arch + "-apple-ios18.0-simulator", RENDERER, stage / "main.swift",
                "-o", app / "FontDiagnostic", "-framework", "UIKit", "-framework", "CoreText",
                "-framework", "CoreImage", timeout=300)
            run("codesign", "--force", "--sign", "-", app)
            udid = run("xcrun", "simctl", "create", "K3-Font-" + stage.name, device["identifier"], runtime["identifier"])
            metadata["simulatorUUID"] = udid
            run("xcrun", "simctl", "boot", udid)
            run("xcrun", "simctl", "bootstatus", udid, "-b", timeout=300)
            run("xcrun", "simctl", "install", udid, app)
            run("xcrun", "simctl", "launch", udid, bundle)
            documents = pathlib.Path(run("xcrun", "simctl", "get_app_container", udid, bundle, "data")) / "Documents"
            deadline = time.monotonic() + 90
            while not (documents / "report.json").exists() and time.monotonic() < deadline:
                time.sleep(1)
            assert (documents / "report.json").exists(), "Native app did not finish writing report"
            for file in documents.iterdir():
                if file.suffix in (".json", ".png"):
                    shutil.copy2(file, output / file.name)
            report = json.loads((output / "report.json").read_text())
            summary = validate_report(report, fixtures)
            for case in fixtures["textCases"]:
                assert (output / (case["id"] + ".png")).is_file(), "Missing PNG evidence"
            for attempt in report["productionAttempts"]:
                for element in attempt["elements"]:
                    if element["type"] == "image":
                        assert (output / element["bitmap"]["png"]).is_file()
            for result in report["rendererRegressions"]:
                for bitmap in result.get("bitmaps", []):
                    assert (output / bitmap["png"]).is_file()
            calibration_attempts = [report["productionAttempts"][0]] + report["calibrationRegressions"]
            for attempt in calibration_attempts:
                for image in attempt["calibrationEvidence"]["images"]:
                    assert (output / image["png"]).is_file()
                for element in attempt["elements"]:
                    if element["type"] == "image":
                        assert (output / element["bitmap"]["png"]).is_file()
            (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
            metadata["status"] = summary["status"]
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            summary_file = pathlib.Path(os.environ.get("GITHUB_STEP_SUMMARY", output / "summary.md"))
            with summary_file.open("a", encoding="utf-8") as handle:
                handle.write("## K3 Font Regression\n\n12 native diagnostic cases, 15 rasterizer regressions, 3 production renderer attempts and 2 independent calibration layout checks passed.\n\n")
                for attempt in report["productionAttempts"]:
                    handle.write("- " + attempt["id"] + ": " + attempt.get("errorCode", attempt["outcome"])
                                 + "; SDK stub calls: " + str(attempt["sdkStubCalls"]) + "\n")
                handle.write("\nBase-font unmapped calibration characters: "
                             + json.dumps(summary["calibrationBaseUnmappedGraphemes"], ensure_ascii=False)
                             + "\n\nDownload the artifact for fixtures, report.json, reference PNGs and actual production rasterizer PNGs. "
                             + "SDK uses a test double. No business writes, device SDK execution or physical printing were performed. Native IPA rebuild and physical acceptance remain required.\n")
    except Exception as error:
        metadata["status"] = "diagnostic-runner-failed"
        metadata["error"] = str(error)
        if udid:
            run("xcrun", "simctl", "spawn", udid, "log", "show", "--last", "2m", "--style", "compact",
                "--predicate", 'process == "FontDiagnostic"', check=False)
        raise
    finally:
        (output / "provenance.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        if udid:
            run("xcrun", "simctl", "shutdown", udid, check=False)
            run("xcrun", "simctl", "delete", udid, check=False)


if __name__ == "__main__":
    main()
