"""Reproduce the checked-in renderer on iOS, without linking or submitting to JCAPI."""

import argparse
import hashlib
import json
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
    if not original["baseFontDirectMapping"]:
        assert calibration["errorCode"] == "FONT_GLYPH_MISSING" and calibration["sdkStubCalls"] == 0
    else:
        assert calibration.get("errorCode") != "FONT_GLYPH_MISSING"
    snapshots = {x["id"]: x for x in report["parsedSnapshots"]}
    for case in fixtures["templateCases"]:
        text = "\n".join(x["text"] for x in snapshots[case["id"]]["fields"])
        assert all(token in text for token in case["expectedTextTokens"]), "Parsed snapshot dropped fixture data"
    return {
        "status": "diagnostics-completed-not-a-production-fix",
        "nativeTextCases": len(results),
        "productionRendererAttempts": len(attempts),
        "calibrationResult": calibration,
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
            (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
            metadata["status"] = summary["status"]
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            summary_file = pathlib.Path(os.environ.get("GITHUB_STEP_SUMMARY", output / "summary.md"))
            with summary_file.open("a", encoding="utf-8") as handle:
                handle.write("## K3 Font Diagnostics\n\n12 native text cases and 3 production renderer attempts completed.\n\n")
                for attempt in report["productionAttempts"]:
                    handle.write("- " + attempt["id"] + ": " + attempt.get("errorCode", attempt["outcome"])
                                 + "; SDK stub calls: " + str(attempt["sdkStubCalls"]) + "\n")
                handle.write("\nBase-font unmapped calibration characters: "
                             + json.dumps(summary["calibrationBaseUnmappedGraphemes"], ensure_ascii=False)
                             + "\n\nDownload the artifact for fixtures, report.json and 12 CoreText reference PNGs. "
                             + "No business writes or physical printing were performed. This is not a production fix.\n")
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
