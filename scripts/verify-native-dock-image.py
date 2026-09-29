"""Verify the approved dark dock from the actual simulator compositor image."""
import base64
import io
import json
import pathlib
import sys

from PIL import Image, ImageStat

directory = pathlib.Path(sys.argv[1])
result = json.loads((directory / 'result.json').read_text(encoding='utf-8'))
image = Image.open(directory / 'simulator.png').convert('RGB')
frame = result['dockFrame']
scale = image.width / frame['width']
sample = image.crop((int(image.width * .25), int((frame['y'] + 10) * scale),
                     int(image.width * .75), int((frame['y'] + 55) * scale)))
mean = ImageStat.Stat(sample).mean
luminance = .2126 * mean[0] + .7152 * mean[1] + .0722 * mean[2]
preview = image.crop((0, int(frame['y'] * scale), image.width, image.height))
preview.thumbnail((280, 70))
buffer = io.BytesIO()
preview.save(buffer, format='JPEG', quality=35)
(directory / 'dock-preview.jpg').write_bytes(buffer.getvalue())
payload = json.dumps({'luminance':round(luminance, 1),
                      'base64':base64.b64encode(buffer.getvalue()).decode()})
assert len(payload) < 3900, 'Dock preview exceeds CI annotation limit'
print('::notice title=Native dock appearance::' + payload)
if luminance >= 180:
    for offset in range(0, len(result.get('nativeHierarchy', [])), 20):
        detail = '\n'.join(result['nativeHierarchy'][offset:offset + 20])
        escaped = detail.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print('::notice title=Native dock hierarchy::' + escaped[:3800])
    print('::error title=Native dock appearance::Native dock is light; preserve the approved dark material')
    sys.exit(1)
