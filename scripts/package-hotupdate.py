from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import re
import sys

source = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
output = Path(sys.argv[2] if len(sys.argv) > 2 else "release/www.zip")
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
print(f"created {output} with {len(files)} files")
