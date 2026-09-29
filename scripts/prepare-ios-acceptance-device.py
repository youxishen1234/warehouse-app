"""Create one CI-owned simulator and install the already-built Debug app."""
import json
import pathlib
import subprocess

directory = pathlib.Path('release/ios-final-acceptance')
directory.mkdir(parents=True, exist_ok=True)

def simctl(*arguments, timeout=60):
    return subprocess.check_output(['xcrun', 'simctl', *arguments], text=True, timeout=timeout).strip()

runtimes = json.loads(simctl('list', 'runtimes', '-j'))['runtimes']
candidates = [r for r in runtimes if r.get('isAvailable') and r.get('name', '').startswith('iOS') and int(r['version'].split('.')[0]) >= 26]
if not candidates:
    raise SystemExit('An installed iOS 26+ runtime is required')
runtime = max(candidates, key=lambda r: tuple(int(p) for p in r['version'].split('.')))
types = json.loads(simctl('list', 'devicetypes', '-j'))['devicetypes']
device_type = next((d for d in types if d['name'] == 'iPhone 17 Pro'), None)
if device_type is None:
    raise SystemExit('The expected iPhone 17 Pro device type is unavailable')
device = simctl('create', 'Warehouse-Final-Acceptance', device_type['identifier'], runtime['identifier'])
(directory / 'device-id.txt').write_text(device, encoding='utf-8')
print('Created CI-owned simulator:', device, flush=True)
simctl('boot', device)
simctl('bootstatus', device, '-b', timeout=180)
simctl('install', device, 'release/ios-acceptance-derived/Build/Products/Debug-iphonesimulator/App.app', timeout=180)
