"""Shared server release gate. Run via SSH; no business database writes."""
from pathlib import Path
from contextlib import contextmanager
from hashlib import sha256
from datetime import datetime, timezone
import json
import os
import re
import sys
import zipfile


@contextmanager
def publication_lock(root):
    try:
        with (root / 'publish.lock').open('a+b') as lock:
            if os.name == 'nt':
                import msvcrt
                lock.seek(0)
                if not lock.read(1):
                    lock.write(b'0')
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == 'nt':
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock, fcntl.LOCK_UN)
    except PermissionError as error:
        raise ValueError('Another release was published since build started; rebuild from latest main') from error


def publish(directory, staging):
    root, incoming = Path(directory).resolve(), Path(staging).resolve()
    if incoming.parent != root or not incoming.name.startswith('.incoming-'):
        raise ValueError('Staging directory must be a unique child of update directory')
    root.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((incoming / 'manifest.json').read_text(encoding='utf-8-sig'))
    version = manifest.get('version', '')
    if not re.fullmatch(r'\d{14}', version):
        raise ValueError('Unified releases require a 14-digit UTC version')
    commit = manifest.get('commit', '')
    ancestors = manifest.get('ancestors', [])
    if not re.fullmatch(r'[a-f0-9]{40,64}', commit) or commit not in ancestors:
        raise ValueError('Release commit provenance is missing')
    archive = incoming / 'www.zip'
    digest = sha256(archive.read_bytes()).hexdigest()
    if manifest.get('sha256') != digest or manifest.get('size') != archive.stat().st_size or manifest.get('integrity') != {'algorithm': 'sha256', 'value': digest}:
        raise ValueError('Release archive integrity mismatch')
    with zipfile.ZipFile(archive) as zipped:
        names = zipped.namelist()
        if 'index.html' not in names or len(names) != len(set(names)) or zipped.testzip():
            raise ValueError('Invalid release archive')
        if any(name.startswith('/') or '\\' in name or '..' in name.split('/') for name in names):
            raise ValueError('Unsafe release archive paths')
        if json.loads(zipped.read('release-info.json')).get('commit') != commit:
            raise ValueError('Archive was built from a different commit')
    with publication_lock(root):
        current_path = root / 'manifest.json'
        current_bytes = current_path.read_bytes() if current_path.exists() else b''
        current = json.loads(current_bytes.decode('utf-8-sig')) if current_bytes else {}
        expected = sha256(current_bytes).hexdigest() if current_bytes else None
        if 'baseManifestSha256' not in manifest or manifest['baseManifestSha256'] != expected:
            raise ValueError('Another release was published since build started; rebuild from latest main')
        old_version = current.get('version', '')
        if old_version and (not re.fullmatch(r'\d{14}', old_version) or version <= old_version):
            raise ValueError('Refusing older or duplicate release version')
        old_commit = current.get('commit')
        if old_commit and old_commit not in ancestors:
            raise ValueError('Release does not include previously published commit')
        if old_commit == commit:
            raise ValueError('This commit has already been published')
        releases = root / 'releases'
        releases.mkdir(exist_ok=True)
        target = releases / (version + '-' + digest[:16] + '.zip')
        if target.exists():
            raise ValueError('Immutable release already exists')
        os.replace(archive, target)
        manifest['url'] = 'releases/' + target.name
        manifest['publishedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        temporary = root / ('.manifest-' + str(os.getpid()) + '.tmp')
        try:
            with temporary.open('w', encoding='utf-8') as stream:
                json.dump(manifest, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, current_path)
        finally:
            temporary.unlink(missing_ok=True)
        return manifest


if __name__ == '__main__':
    try:
        print(json.dumps(publish(sys.argv[1], sys.argv[2]), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
