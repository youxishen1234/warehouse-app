from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
harness = root / "tests" / "official-label-native-harness.swift"
if not harness.exists():
    raise SystemExit("missing official label native harness")
swiftc = shutil.which("swiftc")
if swiftc is None:
    print("Swift compiler unavailable; native harness deferred to macOS CI")
    raise SystemExit(0)
with tempfile.TemporaryDirectory() as tmp:
    binary = Path(tmp) / "official-label-native-harness"
    subprocess.run([swiftc, str(harness), "-o", str(binary)], cwd=root, check=True)
    subprocess.run([str(binary)], cwd=root, check=True)
