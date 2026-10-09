from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from hashlib import sha256
from datetime import datetime, timezone
import json
import os
import re
import sys
import subprocess

source = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
output = Path(sys.argv[2] if len(sys.argv) > 2 else "release/www.zip")
manifest_path = Path(sys.argv[3]) if len(sys.argv) > 3 else output.parent / "manifest.json"
version = os.environ.get("HOTUPDATE_VERSION", "").strip() or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
release_notes = os.environ.get("HOTUPDATE_RELEASE_NOTES", "").strip()
commit = os.environ.get("HOTUPDATE_COMMIT", "").strip()
provenance = {}
if commit:
    if not re.fullmatch(r'[a-f0-9]{40,64}', commit):
        raise SystemExit('Invalid release commit')
    provenance = json.loads((source / 'release-info.json').read_text(encoding='utf-8'))
    if provenance.get('commit') != commit:
        raise SystemExit('Build provenance does not match commit')
    ancestors = subprocess.check_output(['git', 'rev-list', commit], text=True).splitlines()
    baseline = Path(os.environ['HOTUPDATE_BASE_MANIFEST']).read_bytes()
# Keep release ordering predictable across clients: accept either the existing
# UTC timestamp form or a three-part semantic version with an optional suffix.
if not re.fullmatch(r"(?:\d{14}|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)", version):
    raise SystemExit("HOTUPDATE_VERSION must be a 14-digit UTC timestamp or semantic version")
if not source.is_dir():
    raise SystemExit(f"source directory does not exist: {source}")
files = sorted(p for p in source.rglob("*") if p.is_file())
if not files or not (source / "index.html").is_file():
    raise SystemExit("hot update must contain a root index.html")
output.parent.mkdir(parents=True, exist_ok=True)
for file in files:
    if file.is_symlink() or not re.fullmatch(r"[A-Za-z0-9_./-]+", file.relative_to(source).as_posix()):
        raise SystemExit(f"unsupported path: {file}")
with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9, allowZip64=False) as archive:
    for file in files:
        relative = file.relative_to(source).as_posix()
        if any(ord(ch) > 127 for ch in relative):
            raise SystemExit(f"non-ASCII file name: {relative}")
        archive.write(file, relative)
with ZipFile(output) as archive:
    assert "index.html" in archive.namelist()
    assert all(info.compress_type == ZIP_DEFLATED for info in archive.infolist())
    assert archive.testzip() is None

# Publish an integrity-bearing manifest alongside the archive.  Consumers can
# verify the exact bytes before installing; write it atomically so a watcher
# never observes a half-written JSON document.
zip_bytes = output.read_bytes()
manifest = {
    "version": version,
    "url": output.name,
    "publishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "releaseNotes": release_notes,
    "commit": commit,
    **({'ancestors': ancestors, 'baseManifestSha256': sha256(baseline).hexdigest() if baseline else None,
        'sourceSha256': provenance.get('sourceSha256')} if commit else {}),
    "size": len(zip_bytes),
    "sha256": sha256(zip_bytes).hexdigest(),
    "integrity": {"algorithm": "sha256", "value": sha256(zip_bytes).hexdigest()},
}
manifest_path.parent.mkdir(parents=True, exist_ok=True)
manifest_tmp = manifest_path.with_name(f"{manifest_path.name}.tmp-{os.getpid()}")
manifest_tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
manifest_tmp.replace(manifest_path)
print(f"created {output} with {len(files)} files; manifest {manifest_path}")
