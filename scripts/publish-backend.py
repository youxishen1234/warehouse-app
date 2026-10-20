"""Publish a verified backend bundle on the warehouse host.

Run as root or the service account from a unique staging directory. The
server's business data, account state, private attachments and public files
are deliberately outside this transaction.
"""

from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from contextlib import contextmanager
import base64
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time


SCRIPT_DIR = Path(__file__).resolve().parent
DAILY_STATUS_VERIFIER = SCRIPT_DIR / 'verify-backend-daily-status.js'


REQUIRED = {
    'server.js', 'db.js', 'team.js', 'daily-backup.js',
    'product-image-backup.js', 'ledger-attachments.js',
    'business-workflow.js', 'package.json', 'package-lock.json'
}


def error(message):
    raise ValueError(message)


def safe_path(base, relative):
    parts = (relative or '').split('/')
    if not parts or any(not re.fullmatch(r'[A-Za-z0-9_.-]+', part) or part in ('.', '..') for part in parts):
        error('unsafe backend release path')
    target = (base / relative).resolve()
    if target != base and base not in target.parents:
        error('backend release path escapes target directory')
    return target


def local_require_closure(relative, files):
    pending, seen = [relative], set()
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        text = files[current].decode('utf-8')
        for match in re.finditer(r"""require\(\s*['"]\./([^'"]+)['"]\s*\)""", text):
            dependency = match.group(1)
            candidates = [dependency, dependency + '.js', dependency + '/index.js']
            found = next((candidate for candidate in candidates if candidate in files), None)
            if not found or found.startswith('../') or found.startswith('/'):
                error('backend release has a missing or unsafe local dependency')
            pending.append(found)
    return seen


def load_bundle(path, expected_commit=None):
    bundle = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if bundle.get('format') != 'warehouse-backend-release-v1':
        error('invalid backend release format')
    commit = expected_commit or bundle.get('commit', '')
    if not re.fullmatch(r'[a-f0-9]{40,64}', commit or '') or bundle.get('commit') != commit:
        error('backend release commit mismatch')
    files = bundle.get('files')
    if not isinstance(files, dict) or not files or not REQUIRED <= set(files):
        error('backend release is incomplete')
    decoded = {}
    for name, metadata in files.items():
        if any(not re.fullmatch(r'[A-Za-z0-9_.-]+', part) or part in ('.', '..') for part in (name or '').split('/')):
            error('unsafe backend release path')
        if not isinstance(metadata, dict) or not isinstance(metadata.get('data'), str):
            error('invalid backend release metadata')
        try:
            content = base64.b64decode(metadata['data'], validate=True)
        except Exception:
            error('invalid backend release content')
        if len(content) != metadata.get('size') or sha256(content).hexdigest() != metadata.get('sha256'):
            error('backend release content mismatch')
        if b'\0' in content and not name.endswith(('.node', '.so', '.png', '.jpg', '.jpeg', '.webp')):
            error('backend release contains unexpected binary data')
        decoded[name] = content
    for path_name in local_require_closure('server.js', decoded):
        if path_name not in decoded:
            error('backend release is incomplete: ' + path_name)
    package = json.loads(decoded['package.json'].decode('utf-8'))
    if package.get('name') != 'shuguang-server':
        error('backend release package name mismatch')
    if not any(name.startswith('node_modules/express/') and name.endswith('/package.json') for name in decoded):
        error('backend release is missing express runtime content')
    return commit, files, decoded


def materialize_and_preflight(files):
    with tempfile.TemporaryDirectory(prefix='warehouse-backend-preflight-') as directory:
        root = Path(directory)
        for name, content in files.items():
            target = safe_path(root, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
        script = (
            "const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');"
            "const root=process.cwd(),data=path.join(root,'.preflight-data.json');"
            "fs.writeFileSync(data,JSON.stringify({products:[],customers:[],suppliers:[],transactions:[],ledger:[]}));"
            "const env={...process.env,WAREHOUSE_DATA_FILE:data,WAREHOUSE_BACKUP_DIR:path.join(root,'.preflight-protection'),"
            "WAREHOUSE_DAILY_BACKUP_DIR:path.join(root,'.preflight-daily'),WAREHOUSE_PRODUCT_IMAGE_DIR:path.join(root,'.preflight-images'),"
            "WAREHOUSE_DAILY_BACKUP_ENABLED:'false',PORT:'0'};"
            "const child=spawn(process.execPath,['-e',\"const app=require('./server');const server=app.startServer();server.once('listening',()=>process.stdout.write('READY '+server.address().port));\"],"
            "{cwd:root,env,stdio:['ignore','pipe','pipe']});"
            "let output='',failure='',finished=false;const finish=code=>{if(finished)return;finished=true;clearTimeout(timeout);child.kill('SIGTERM');if(code){console.error(failure);process.exitCode=1};};"
            "const timeout=setTimeout(()=>finish(1),20000);"
            "child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/READY (\\d+)/);if(!match||finished)return;"
            "const request=http.request({host:'127.0.0.1',port:Number(match[1]),path:'/api/auth/guest',method:'POST',headers:{'Content-Type':'application/json','Content-Length':'2'}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{try{const json=JSON.parse(body);if(response.statusCode!==200||!json.data||!json.data.token)throw Error('guest preflight contract failed');finish(0)}catch(e){failure=e.message;finish(1)}})});"
            "request.on('error',e=>{failure=e.message;finish(1)});request.end('{}')});"
            "child.stderr.on('data',chunk=>failure+=chunk);child.on('exit',code=>{if(!finished){failure+='preflight exited '+code;finish(code||1)}});"
        )
        result = subprocess.run(['node', '-e', script], cwd=root, text=True, capture_output=True, timeout=30,
                                env={**os.environ, 'NODE_ENV': 'test'})
        if result.returncode:
            error('staged backend preflight failed: ' + (result.stderr or result.stdout)[-3000:])


def service_properties():
    output = subprocess.check_output(
        ['systemctl', 'show', 'shuguang.service', '--property=User',
         '--property=WorkingDirectory', '--property=Environment', '--property=EnvironmentFiles',
         '--property=DropInPaths', '--no-pager'],
        text=True
    )
    properties = {}
    for line in output.splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            properties[key] = value
    if properties.get('User') in ('', 'root'):
        error('service must run as a non-root user')
    working = Path(properties.get('WorkingDirectory') or '')
    if not working.is_absolute() or working == Path('/'):
        error('service working directory is invalid')
    return properties, working


def run_healthcheck(working, token, request_id):
    if not DAILY_STATUS_VERIFIER.is_file():
        error('daily status verifier is missing')
    environment = dict(os.environ, BACKEND_ACCEPTANCE_TOKEN=token, BACKEND_ACCEPTANCE_REQUEST=request_id)
    try:
        return subprocess.check_output(
            ['node', str(DAILY_STATUS_VERIFIER)], cwd=working, text=True, timeout=30,
            env=environment, stderr=subprocess.STDOUT
        ).strip()
    except subprocess.CalledProcessError as exception:
        error('daily status verification failed: ' + (exception.output or 'no output').strip())


def service_environment(properties):
    environment = {}
    for assignment in properties.get('Environment', '').split():
        if '=' not in assignment:
            continue
        key, value = assignment.split('=', 1)
        if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            environment[key] = value
    for path in properties.get('EnvironmentFiles', '').split():
        candidate = Path(path)
        if candidate.is_file():
            for line in candidate.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
                    environment[key] = value.strip().strip('"').strip("'")
    return environment


def healthcheck(working, service_environment):
    token = os.environ.get('BACKEND_ACCEPTANCE_TOKEN') or service_environment.get('BACKEND_ACCEPTANCE_TOKEN')
    request_id = 'backend-release-' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    if token:
        return run_healthcheck(working, token, request_id)
    origin = os.environ.get('BACKEND_ACCEPTANCE_ORIGIN', 'http://127.0.0.1:4000')
    if not re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):\d{1,5}', origin):
        error('BACKEND_ACCEPTANCE_ORIGIN must be loopback HTTP')
    if not DAILY_STATUS_VERIFIER.is_file():
        error('daily status verifier is missing')
    port = origin.rsplit(':', 1)[1]
    try:
        return subprocess.check_output(
            ['node', str(DAILY_STATUS_VERIFIER)], cwd=working, text=True, timeout=30,
            env=dict(os.environ, BACKEND_ACCEPTANCE_PORT=port, BACKEND_ACCEPTANCE_REQUEST=request_id),
            stderr=subprocess.STDOUT
        ).strip()
    except subprocess.CalledProcessError as exception:
        error('daily status verification failed: ' + (exception.output or 'no output').strip())


@contextmanager
def release_lock(root):
    path = root / '.backend-release.lock'
    with path.open('a+b') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def restart_service():
    sudo = [] if os.geteuid() == 0 else ['sudo', '-n']
    result = subprocess.run([*sudo, 'systemctl', 'restart', 'shuguang.service'], text=True, capture_output=True)
    if result.returncode:
        error('service restart failed: ' + result.stderr[-2000:])
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if subprocess.run([*sudo, 'systemctl', 'is-active', '--quiet', 'shuguang.service']).returncode == 0:
            return
        time.sleep(1)
    error('service did not become active after restart')


def restore_file(backup, working, name):
    old = backup / 'files' / name
    target = safe_path(working, name)
    if not old.exists():
        target.unlink(missing_ok=True)
        return
    temporary = target.with_name('.' + target.name + '.rollback-' + str(os.getpid()))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(old, temporary)
    os.replace(temporary, target)


def publish(bundle_file, backup_root, acceptance_file, restart=False):
    commit, metadata, decoded = load_bundle(bundle_file, os.environ.get('RELEASE_COMMIT'))
    materialize_and_preflight(decoded)
    properties, working = service_properties()
    service_env = service_environment(properties)
    backup_root = Path(backup_root).resolve()
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = backup_root / ('backend-' + commit[:12] + '-' + stamp)
    backup.mkdir(mode=0o700)
    staged = working.parent / ('.backend-stage-' + stamp + '-' + str(os.getpid()))
    staged.mkdir(mode=0o700)
    changed = []
    started = time.monotonic()
    with release_lock(working.parent):
        # Re-read the service so a configuration or working directory change
        # cannot be silently bypassed between plan and publication.
        _, working = service_properties()
        try:
            (backup / 'release.json').write_text(json.dumps({
                'commit': commit, 'service': 'shuguang.service',
                'user': properties.get('User'), 'workingDirectory': str(working),
                'files': metadata
            }, ensure_ascii=False, indent=2), encoding='utf-8')
            for name in decoded:
                target = safe_path(working, name)
                if target.exists():
                    old = backup / 'files' / name
                    old.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, old)
            for name, content in decoded.items():
                target = staged / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
            # Dependency content is part of this verified bundle, so no
            # network install can change the release during publication.
            for name, content in decoded.items():
                target = safe_path(working, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists() or target.read_bytes() != content:
                    changed.append(name)
            acceptance = Path(acceptance_file).resolve()
            if not changed:
                acceptance.write_text(healthcheck(working, service_env), encoding='utf-8')
                return
            # Replace files atomically one at a time and record the old set for rollback.
            try:
                for name in sorted(changed):
                    target = safe_path(working, name)
                    temporary = target.with_name('.' + target.name + '.tmp-' + str(os.getpid()))
                    shutil.copy2(staged / name, temporary)
                    os.replace(temporary, target)
                if restart:
                    restart_service()
                acceptance.write_text(healthcheck(working, service_env), encoding='utf-8')
            except BaseException:
                for name in reversed(changed):
                    restore_file(backup, working, name)
                if restart:
                    restart_service()
                raise
        finally:
            shutil.rmtree(staged, ignore_errors=True)
    print(json.dumps({
        'commit': commit,
        'restartRequired': bool(changed),
        'changedFiles': changed,
        'backup': str(backup),
        'acceptance': str(acceptance),
        'startedAt': started
    }, ensure_ascii=False))


if __name__ == '__main__':
    try:
        arguments = [argument for argument in sys.argv[1:] if argument != '--restart']
        if len(arguments) != 3:
            error('usage: publish-backend.py bundle.json backup-root acceptance.json [--restart]')
        publish(arguments[0], arguments[1], arguments[2], restart='--restart' in sys.argv)
    except Exception as exception:
        print(str(exception), file=sys.stderr)
        sys.exit(1)
