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
W, H = image.size

# On iOS 26 the floating Liquid Glass platter sits near the very bottom of
# the screen (~93%–99% down the screen on a modern iPhone). Sample by
# fraction of the screenshot instead of deriving pixels-per-point from
# dockFrame.width (which is the platter width, not the screen width).
top = int(H * 0.935)
bottom = int(H * 0.965)
left = int(W * 0.30)
right = int(W * 0.70)
sample = image.crop((left, top, right, bottom))
mean = ImageStat.Stat(sample).mean
luminance = .2126 * mean[0] + .7152 * mean[1] + .0722 * mean[2]

# Preview: the lower strip where the dock lives.
preview = image.crop((0, int(H * 0.90), W, H))
preview.thumbnail((280, 70))
buffer = io.BytesIO()
preview.save(buffer, format='JPEG', quality=35)
(directory / 'dock-preview.jpg').write_bytes(buffer.getvalue())

print(f'::notice title=Native dock probe::image={W}x{H} dockFrame={frame} sample=({left},{top})-({right},{bottom}) luminance={round(luminance,1)}')

payload = json.dumps({'luminance': round(luminance, 1),
                      'base64': base64.b64encode(buffer.getvalue()).decode()})
assert len(payload) < 3900, 'Dock preview exceeds CI annotation limit'
print('::notice title=Native dock appearance::' + payload)

# A dark background alone is not acceptance: an effect layered above the
# system tab content also darkens its icons. Require a visible bright icon
# inside each tab, excluding the platter edges and its specular highlights.
icon_checks = []
for center in (.185, .396, .607, .818):
    cx = int(W * center)
    icon = image.crop((cx - int(W * 0.022), int(H * 0.955),
                       cx + int(W * 0.022), int(H * 0.980)))
    pixels = list(icon.getdata())
    bright = sum(max(pixel) >= 150 for pixel in pixels)
    icon_checks.append(bright / max(1, len(pixels)))
print('Native dock bright-icon fractions:', [round(x, 3) for x in icon_checks])
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
