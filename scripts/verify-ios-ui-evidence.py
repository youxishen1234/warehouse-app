#!/usr/bin/env python3
"""Check exported XCTest evidence, not appearance or production acceptance.

Usage: python verify-ios-ui-evidence.py UI_TESTS_DIR --expected-source RUN_SOURCE
RUN_SOURCE must be the NativeDockInteractionTests.swift used by that run. There
is deliberately no default method list. SHA-256 identifies the supplied bytes;
it does not authenticate the CI run, source revision, or screenshot provenance.
Requires Pillow, already used by the native appearance verifier.
"""
import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import sys


SUITE = "NativeDockInteractionTests"
TAP_TEST = "testTapEveryNativeTab"
ROTATION_TEST = "testRotateAndTapNativeTabs"
UUID = r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}"
CASE = re.compile(r"^Test Case '-\[(?P<class>[\w.]+) (?P<method>\w+)\]' "
                  r"(?P<state>started|passed|failed|skipped)\b(?P<tail>.*)$")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def swift_code(source):
    """Mask strings/comments before reading declarations; retain line positions."""
    result = list(source)
    index = 0
    while index < len(source):
        start = index
        if source.startswith("//", index):
            index = source.find("\n", index)
            if index < 0:
                index = len(source)
        elif source.startswith("/*", index):
            index += 2
            depth = 1
            while index < len(source) and depth:
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise ValueError("Unterminated Swift block comment")
        else:
            string = re.match(r'(\#*)("""|")', source[index:])
            if not string:
                index += 1
                continue
            hashes, quote = string.groups()
            index += len(string.group())
            while index < len(source):
                if source.startswith(quote + hashes, index):
                    index += len(quote + hashes)
                    break
                if source.startswith("\\" + hashes, index):
                    index += len(hashes) + 2
                else:
                    index += 1
            else:
                raise ValueError("Unterminated Swift string")
        result[start:index] = ["\n" if char == "\n" else " " for char in source[start:index]]
    return "".join(result)


def expected_methods(source):
    code = swift_code(source)
    classes = list(re.finditer(r"\bclass\s+" + SUITE + r"\s*:\s*XCTestCase\s*\{", code))
    if len(classes) != 1 or re.search(r"\bextension\s+" + SUITE + r"\b", code):
        raise ValueError("Expected one self-contained NativeDockInteractionTests: XCTestCase class")
    start, depth, end = classes[0].end(), 1, None
    for index in range(start, len(code)):
        depth += (code[index] == "{") - (code[index] == "}")
        if depth == 0:
            end = index
            break
    if end is None:
        raise ValueError("Unclosed Swift test class")
    body, methods = code[start:end], []
    for match in re.finditer(r"\bfunc\s+(test\w*)\s*\(([^)]*)\)", body):
        before = body[:match.start()]
        if before.count("{") != before.count("}"):
            continue
        if match.group(2).strip():
            raise ValueError("Expected zero-argument XCTest method: " + match.group(1))
        methods.append(match.group(1))
    if not methods or len(methods) != len(set(methods)) or TAP_TEST not in methods:
        raise ValueError("Expected unique XCTest methods including " + TAP_TEST)
    return sorted(methods)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key: " + key)
        result[key] = value
    return result


def verify(evidence_dir, expected_source):
    report = {"schemaVersion": 1, "status": "failed", "inputs": {},
              "acceptance": {"visual": "not_assessed", "production": "not_assessed",
                             "provenance": "hashes_recorded_not_authenticated"},
              "expectedMethods": [], "tests": [], "attachments": [],
              "requiredScreenshots": [], "failures": []}

    def fail(code, detail):
        report["failures"].append({"code": code, "detail": detail})

    def read_input(label, path):
        data = path.read_bytes()
        report["inputs"][label] = {"path": str(path.resolve()), "sha256": digest(data)}
        return data.decode("utf-8-sig")

    try:
        root = Path(evidence_dir).resolve(strict=True)
        methods = expected_methods(read_input("expectedSource", Path(expected_source)))
        report["expectedMethods"] = methods
        log = "\n".join(read_input("xcodebuildLog", root / "xcodebuild.log").splitlines())
        manifest = json.loads(read_input("attachmentManifest", root / "attachments" / "manifest.json"),
                              object_pairs_hook=unique_object)
        status = read_input("exitStatus", root / "exit-status.txt").strip()
        if status != "0":
            fail("xcodebuild_exit", "Expected xcodebuild exit status 0; found " + repr(status))

        events = {method: [] for method in methods}
        for number, line in enumerate(log.splitlines(), 1):
            case = CASE.fullmatch(line)
            if case:
                entry = case.groupdict()
                if entry["state"] in ("failed", "skipped"):
                    fail("test_not_passed", "Line {}: {}".format(number, line))
                if entry["class"].split(".")[-1] == SUITE:
                    method = entry["method"]
                    if method not in events:
                        fail("unexpected_method", "Line {}: {}".format(number, method))
                    else:
                        events[method].append({"state": entry["state"], "line": number})
            elif "Test Case " in line and SUITE in line:
                fail("unrecognized_test_line", "Line {}: {}".format(number, line))
            if re.search(r"^Test Suite .* (failed|skipped)\b|^\*\* TEST.* FAILED \*\*", line):
                fail("run_failed", "Line {}: {}".format(number, line))
        for method, observed in events.items():
            report["tests"].append({"method": method, "events": observed})
            if [event["state"] for event in observed] != ["started", "passed"]:
                fail("method_lifecycle", method + " must have exactly one started then one passed event")
        suites = re.findall(r"^Test Suite '" + SUITE + r"' passed[^\n]*\n\s*Executed (\d+) tests?, "
                            r"with (\d+) failures? \((\d+) unexpected\)", log, re.MULTILINE)
        if suites != [(str(len(methods)), "0", "0")]:
            fail("suite_summary", "Expected one completed suite summary with all expected methods and zero failures")
        if len(re.findall(r"^\*\* TEST (?:EXECUTE )?SUCCEEDED \*\*$", log, re.MULTILINE)) != 1:
            fail("run_completion", "Expected one xcodebuild TEST SUCCEEDED or TEST EXECUTE SUCCEEDED marker")

        if not isinstance(manifest, list) or not manifest:
            raise ValueError("Attachment manifest must be a nonempty array from xcresulttool export attachments")
        attachment_root = (root / "attachments").resolve(strict=True)
        manifest_methods, seen_files = [], set()
        from PIL import Image
        for item in manifest:
            if not isinstance(item, dict):
                raise ValueError("Manifest test entry must be an object")
            match = re.fullmatch(SUITE + r"/(test\w*)\(\)", str(item.get("testIdentifier", "")))
            if not match:
                raise ValueError("Unrecognized manifest testIdentifier: " + repr(item.get("testIdentifier")))
            method = match.group(1)
            manifest_methods.append(method)
            attachments = item.get("attachments")
            if not isinstance(attachments, list) or not attachments:
                raise ValueError("Expected nonempty attachment array for " + method)
            for attachment in attachments:
                if not isinstance(attachment, dict):
                    raise ValueError("Attachment must be an object")
                name, filename = attachment.get("suggestedHumanReadableName"), attachment.get("exportedFileName")
                if not isinstance(filename, str) or not filename or re.search(r"[/\\:\x00]", filename) or filename.endswith((".", " ")):
                    fail("unsafe_attachment_path", repr(filename))
                    continue
                candidate = attachment_root / filename
                path = candidate.resolve()
                if candidate.is_symlink() or path.parent != attachment_root or not path.is_file():
                    fail("missing_or_unsafe_attachment", filename)
                    continue
                if filename.casefold() in seen_files:
                    fail("duplicate_attachment_file", filename)
                seen_files.add(filename.casefold())
                if attachment.get("isAssociatedWithFailure") is not False:
                    fail("failure_attachment", filename + " must explicitly have isAssociatedWithFailure=false")
                if not isinstance(name, str) or not name:
                    fail("attachment_name", filename + " has no suggestedHumanReadableName")
                    continue
                data = path.read_bytes()
                record = {"method": method, "file": filename, "name": name,
                          "sha256": digest(data), "bytes": len(data)}
                if filename.lower().endswith(".png") or name.lower().endswith(".png"):
                    try:
                        if not filename.lower().endswith(".png") or not data.startswith(b"\x89PNG\r\n\x1a\n"):
                            raise ValueError("Expected original PNG attachment bytes and .png filename")
                        with Image.open(io.BytesIO(data)) as image:
                            if image.format != "PNG" or getattr(image, "n_frames", 1) != 1:
                                raise ValueError("Expected a single-frame PNG")
                            image.verify()
                        with Image.open(io.BytesIO(data)) as image:
                            image.load()
                            record["width"], record["height"] = image.size
                            record["format"] = "PNG"
                    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
                        fail("invalid_png", filename + ": " + str(error))
                report["attachments"].append(record)
        if Counter(manifest_methods) != Counter(methods):
            fail("manifest_methods", "Manifest must contain exactly one entry for every expected method")

        required = [(TAP_TEST, "tap-tab-" + str(index), "portrait") for index in range(4)]
        if ROTATION_TEST in methods:
            required += [(ROTATION_TEST, "landscape-tap-tab-1", "landscape"),
                         (ROTATION_TEST, "landscape-tap-tab-3", "landscape"),
                         (ROTATION_TEST, "portrait-after-rotation-tab-0", "portrait")]
        for method, state, orientation in required:
            matches = [record for record in report["attachments"] if record["method"] == method
                       and re.fullmatch(re.escape(state) + r"_\d+_" + UUID + r"\.png", record["name"])]
            if len(matches) != 1 or matches[0].get("format") != "PNG":
                fail("required_screenshot", method + ": expected exactly one valid PNG for " + state)
                continue
            record = matches[0]
            width, height = record["width"], record["height"]
            if not (width > height if orientation == "landscape" else height > width):
                fail("screenshot_orientation", state + " dimensions disagree with " + orientation)
            report["requiredScreenshots"].append(dict(record, state=state, orientation=orientation))
    except (OSError, ValueError, TypeError, ImportError) as error:
        fail("invalid_input", str(error))
    report["counts"] = {"expectedMethods": len(report["expectedMethods"]),
                        "started": sum(event["state"] == "started" for test in report["tests"] for event in test["events"]),
                        "passed": sum(event["state"] == "passed" for test in report["tests"] for event in test["events"]),
                        "attachments": len(report["attachments"]),
                        "validPngs": sum(item.get("format") == "PNG" for item in report["attachments"])}
    if not report["failures"]:
        report["status"] = "evidence_complete"
    return report


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({"schemaVersion": 1, "status": "failed",
                          "failures": [{"code": "arguments", "detail": message}]}))
        raise SystemExit(2)


def main(argv=None):
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("evidence_dir", type=Path, help="Directory containing xcodebuild.log, exit-status.txt and attachments/")
    parser.add_argument("--expected-source", required=True, type=Path, help="Exact Swift test source used by the evidence run")
    args = parser.parse_args(argv)
    report = verify(args.evidence_dir, args.expected_source)
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report["status"] == "evidence_complete" else 1


if __name__ == "__main__":
    sys.exit(main())
