"""Inspect the K3 full-page calibration bitmap without touching the printer."""

import base64
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
RENDERER = ROOT / "ios/App/App/LabelTemplateRenderer.swift"
HARNESS = ROOT / "tests/calibration-bitmap-harness.swift"
OUTPUT = pathlib.Path(os.environ.get("CALIBRATION_BITMAP_OUTPUT_DIR", str(ROOT / "release/calibration-bitmap-ios")))


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Calibration bitmap test NOT EXECUTED: macOS and Xcode are required.")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    stage = pathlib.Path(tempfile.mkdtemp(prefix="calibration-bitmap-", dir=ROOT / "release"))
    try:
        sdk = subprocess.check_output(
            ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], text=True
        ).strip()
        arch = "arm64" if platform.machine() == "arm64" else "x86_64"
        binary = stage / "calibration-bitmap"
        subprocess.run(
            [
                "xcrun", "--sdk", "iphonesimulator", "swiftc", "-swift-version", "5", "-sdk", sdk,
                "-target", arch + "-apple-ios18.0-simulator", str(RENDERER), str(HARNESS),
                "-o", str(binary), "-framework", "UIKit", "-framework", "CoreText", "-framework", "CoreImage",
            ],
            cwd=ROOT,
            check=True,
        )
        runtimes = json.loads(subprocess.check_output(
            ["xcrun", "simctl", "list", "runtimes", "-j"], text=True
        ))["runtimes"]
        available = [
            x for x in runtimes
            if x.get("isAvailable") and "SimRuntime.iOS-" in x.get("identifier", "")
            and int(x.get("version", "0").split(".")[0]) >= 26
        ]
        if not available:
            raise SystemExit("No iOS 26+ simulator runtime is available")
        runtime = max(available, key=lambda x: tuple(int(y) for y in x["version"].split(".")))
        types = json.loads(subprocess.check_output(
            ["xcrun", "simctl", "list", "devicetypes", "-j"], text=True
        ))["devicetypes"]
        device = next((x for x in types if x["identifier"].endswith(".iPhone-16")), None)
        if device is None:
            device = next(x for x in types if x["name"].startswith("iPhone"))
        udid = subprocess.check_output(
            ["xcrun", "simctl", "create", "K3-Calibration-Bitmap-" + stage.name, device["identifier"], runtime["identifier"]],
            text=True,
        ).strip()
        try:
            app = stage / "CalibrationBitmap.app"
            app.mkdir()
            shutil.copy2(binary, app / "CalibrationBitmap")
            info = {
                "CFBundleExecutable": "CalibrationBitmap",
                "CFBundleIdentifier": "com.warehouse.calibrationbitmap",
                "CFBundleName": "CalibrationBitmap",
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": "1",
                "CFBundleShortVersionString": "1.0",
                "MinimumOSVersion": "18.0",
                "LSRequiresIPhoneOS": True,
                "UIDeviceFamily": [1, 2],
                "UILaunchScreen": {},
            }
            import plistlib
            with (app / "Info.plist").open("wb") as handle:
                plistlib.dump(info, handle)
            subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
            subprocess.run(["xcrun", "simctl", "boot", udid], check=True)
            subprocess.run(["xcrun", "simctl", "bootstatus", udid, "-b"], check=True)
            subprocess.run(["xcrun", "simctl", "install", udid, str(app)], check=True)
            subprocess.run(["xcrun", "simctl", "launch", udid, "com.warehouse.calibrationbitmap"], check=True)
            documents = pathlib.Path(subprocess.check_output(
                ["xcrun", "simctl", "get_app_container", udid, "com.warehouse.calibrationbitmap", "data"], text=True
            ).strip()) / "Documents"
            import time
            deadline = time.monotonic() + 45
            while not (documents / "result.json").exists() and time.monotonic() < deadline:
                time.sleep(1)
            if not (documents / "result.json").exists():
                raise SystemExit("Native calibration bitmap harness did not finish")
            result = json.loads((documents / "result.json").read_text())
            if result.get("status") != "passed":
                raise SystemExit("Calibration bitmap rejected: " + json.dumps(result, ensure_ascii=False))
            for file in documents.iterdir():
                if file.suffix in (".json", ".png"):
                    shutil.copy2(file, OUTPUT / file.name)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        finally:
            subprocess.run(["xcrun", "simctl", "shutdown", udid], check=False)
            subprocess.run(["xcrun", "simctl", "delete", udid], check=False)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    main()
