"""Install the pinned CPU speech runtime on the warehouse Linux server.

Requires python3-venv and ffmpeg. Run as the warehouse service user:
python3 setup-ai-speech.py --root /opt/shuguang
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
root = pathlib.Path(args.root).resolve() / "runtime" / "speech"
root.mkdir(mode=0o700, parents=True, exist_ok=True)
if not shutil.which("ffmpeg"):
    raise SystemExit("Install ffmpeg before setting up voice recognition")
venv = root / "venv"
subprocess.run(["python3", "-m", "venv", str(venv)], check=True)
requirements = ["numpy==1.26.4", "onnxruntime==1.20.1", "kaldi-native-fbank==1.22.3", "PyYAML==6.0.3", "sentencepiece==0.2.2"]
subprocess.run([str(venv / "bin/pip"), "install", "--disable-pip-version-check", "--timeout", "25", "--retries", "1", *requirements], check=True)
url = "https://modelscope.cn/models/iic/SenseVoiceSmall-onnx/resolve/master/"
# Digests published by the official iic/SenseVoiceSmall-onnx model repository.
digests = {
    "model_quant.onnx": "21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822",
    "tokens.json": "a2594fc1474e78973149cba8cd1f603ebed8c39c7decb470631f66e70ce58e97",
    "am.mvn": "29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5",
    "config.yaml": "f71e239ba36705564b5bf2d2ffd07eece07b8e3f2bbf6d2c99d8df856339ac19",
    "configuration.json": "c57f6a580d63f7465c6a22ba95847aee05a1ae1181f5abddffb943d9febda061",
    "chn_jpn_yue_eng_ko_spectok.bpe.model": "aa87f86064c3730d799ddf7af3c04659151102cba548bce325cf06ba4da4e6a8"
}
def digest(file):
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()
for name, expected in digests.items():
    target = root / name
    if target.exists() and digest(target) == expected:
        continue
    print("Downloading official SenseVoice file: " + name, flush=True)
    temporary = root / (name + ".download")
    source_url = (url.replace("SenseVoiceSmall-onnx", "SenseVoiceSmall") if name.endswith(".bpe.model") else url) + name
    with urllib.request.urlopen(source_url, timeout=45) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output)
    if digest(temporary) != expected:
        raise RuntimeError("Model integrity check failed: " + name)
    temporary.replace(target)
metadata = {"source": url, "sha256": digests, "requirements": requirements}
(root / "installation.json").write_text(json.dumps(metadata, indent=2))
print(json.dumps({"installed": True, **metadata}), flush=True)
