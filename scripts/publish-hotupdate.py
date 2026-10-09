"""Shared server release gate. Run via SSH; no business database writes."""
from pathlib import Path
from contextlib import contextmanager
from hashlib import sha256
from datetime import datetime, timezone
import json
import os
import re
import shutil
import stat
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


def publish(directory, staging, web_directory=None):
    root, incoming = Path(directory).resolve(), Path(staging).resolve()
    if incoming.parent != root or not incoming.name.startswith('.incoming-'):
        raise ValueError('Staging directory must be a unique child of update directory')
    web = Path(web_directory).resolve() if web_directory else None
    if web and web != root.parent:
        raise ValueError('Web directory must be the parent of update directory')
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
        if any(not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or name.startswith('/') or '..' in name.split('/') for name in names):
            raise ValueError('Unsafe release archive paths')
        if any(stat.S_ISLNK(info.external_attr >> 16) for info in zipped.infolist()):
            raise ValueError('Symlinks are not allowed in release archives')
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
        web_target = web / 'web-releases' / target.stem if web else None
        web_link = web / 'web-current' if web else None
        pending_link = web / ('.web-current-' + str(os.getpid())) if web else None
        previous_link = None
        switched = False
        if web:
            if web_link.exists() and not web_link.is_symlink():
                raise ValueError('Refusing to replace an unmanaged web directory')
            previous_link = os.readlink(web_link) if web_link.is_symlink() else None
            if web_target.exists():
                raise ValueError('Immutable web release already exists')
            web_target.mkdir(parents=True)
            try:
                with zipfile.ZipFile(archive) as zipped:
                    zipped.extractall(web_target)
                # Keep hashed chunks reachable for browsers opened before a release.
                # Never replace existing assets, downloads or business files.
                for asset in web_target.rglob('*'):
                    relative = asset.relative_to(web_target)
                    if not asset.is_file() or relative.parts[0] not in ('js', 'css', 'assets', 'static') or not re.search(r'[.-][a-f0-9]{8,}[.-]', asset.name):
                        continue
                    shared = web / relative
                    shared.parent.mkdir(parents=True, exist_ok=True)
                    if shared.exists():
                        if shared.read_bytes() != asset.read_bytes():
                            raise ValueError('Immutable web asset collision: ' + str(relative))
                    else:
                        with shared.open('xb') as stream:
                            stream.write(asset.read_bytes())
                os.symlink(str(Path('web-releases') / target.stem), pending_link, target_is_directory=True)
            except BaseException:
                pending_link.unlink(missing_ok=True)
                shutil.rmtree(web_target)
                raise
        manifest['url'] = 'releases/' + target.name
        manifest['publishedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        temporary = root / ('.manifest-' + str(os.getpid()) + '.tmp')
        try:
            with temporary.open('w', encoding='utf-8') as stream:
                json.dump(manifest, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(archive, target)
            if web:
                os.replace(pending_link, web_link)
                switched = True
            os.replace(temporary, current_path)
        except BaseException:
            if switched:
                if previous_link is None:
                    web_link.unlink()
                else:
                    os.symlink(previous_link, pending_link, target_is_directory=True)
                    os.replace(pending_link, web_link)
            target.unlink(missing_ok=True)
            if web_target:
                shutil.rmtree(web_target)
            raise
        finally:
            temporary.unlink(missing_ok=True)
            if pending_link:
                pending_link.unlink(missing_ok=True)
        return manifest


if __name__ == '__main__':
    try:
        print(json.dumps(publish(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
