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

# A dark background alone is not acceptance: an effect layered above the
# system tab content also darkens its icons. Require a visible bright icon
# inside each tab, excluding the platter edges and its specular highlights.
icon_checks = []
for center in (.185, .396, .607, .818):
    icon = image.crop((int(image.width * center - 10 * scale),
                       int((frame['y'] + 12) * scale),
                       int(image.width * center + 10 * scale),
                       int((frame['y'] + 35) * scale)))
    pixels = list(icon.getdata())
    bright = sum(max(pixel) >= 150 for pixel in pixels)
    icon_checks.append(bright / max(1, len(pixels)))
print('Native dock bright-icon fractions:', icon_checks)
if any(fraction < .035 for fraction in icon_checks):
    print('::error title=Native dock readability::Tab icons lack visible foreground contrast')
    sys.exit(1)
if luminance >= 180:
    for offset in range(0, len(result.get('nativeHierarchy', [])), 20):
        detail = '\n'.join(result['nativeHierarchy'][offset:offset + 20])
        escaped = detail.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print('::notice title=Native dock hierarchy::' + escaped[:3800])
    print('::error title=Native dock appearance::Native dock is light; preserve the approved dark material')
    sys.exit(1)
