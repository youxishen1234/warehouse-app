"""Conservative PNG diagnostics. Exit 1=failed, 2=needs review; report-only exits 0.
Heuristic contrast is not glyph recognition or proof of real tap/drag interaction.
"""
import argparse
import json
import math
import pathlib
import statistics
from PIL import Image, ImageDraw


def luminance(pixel):
    channels = [v / 255 for v in pixel]
    linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
    return sum(w * v for w, v in zip((.2126, .7152, .0722), linear))


def ratio(a, b):
    return (max(a, b) + .05) / (min(a, b) + .05)


def evaluate(image, result):
    image = image.convert('RGB')
    report = {'status': 'failed', 'failures': [], 'reviewReasons': [], 'regions': [],
              'interactionAcceptance': 'Not assessed; requires real XCUITest tap/drag'}
    failures, reviews = report['failures'], report['reviewReasons']
    if result.get('success') is not True:
        failures.append('Native navigation smoke did not succeed')
    if result.get('material') != 'system-liquid-glass':
        failures.append('Expected native Liquid Glass material')
    if result.get('screenshotReady') is not True:
        failures.append('Missing stable screenshotReady handshake')
    try:
        def rectangle(rect):
            vals = [float(rect[k]) for k in ('x', 'y', 'width', 'height')]
            if not all(math.isfinite(v) for v in vals) or min(vals[2:]) <= 0:
                raise ValueError('Invalid rectangle')
            return vals
        wx, wy, ww, wh = rectangle(result['windowBounds'])
        sx, sy = image.width / ww, image.height / wh
        if abs(sx - sy) / max(sx, sy) > .01:
            raise ValueError('Screenshot/window aspect ratio mismatch; stale orientation?')
        def mapped(rect):
            x, y, w, h = rectangle(rect)
            if x < wx or y < wy or x + w > wx + ww + .01 or y + h > wy + wh + .01:
                raise ValueError('Region outside screenshot window')
            box = (round((x - wx) * sx), round((y - wy) * sy),
                   round((x + w - wx) * sx), round((y + h - wy) * sy))
            if box[2] - box[0] < 3 or box[3] - box[1] < 3:
                raise ValueError('Region too small to assess')
            return box
        dock = mapped(result['dockFrame'])
        report['dockPixelFrame'] = dock
        regions = result['imageRegions']
        if not isinstance(regions, list) or not regions:
            raise ValueError('No imageRegions; cannot infer glyphs from fixed positions')
        mapped_regions = []
        for region in regions:
            if region.get('tabIndex') not in range(4) or region.get('role') not in ('icon', 'label'):
                raise ValueError('Unknown region tabIndex/role')
            box = mapped(region['frame'])
            if box[0] < dock[0] or box[1] < dock[1] or box[2] > dock[2] or box[3] > dock[3]:
                raise ValueError('Content region outside dock')
            mapped_regions.append((region, box))
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        failures.append('Unsafe screenshot geometry: ' + str(error))
        return report
    # Preserve 180 sRGB darkness ceiling; this is not WCAG linear luminance.
    dx, dy, dr, db = dock
    width, height = dr - dx, db - dy
    mask = Image.new('1', image.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle((dx + width * .25, dy + height * .12,
                    dx + width * .75, dy + height * .66), fill=1)
    for _, box in mapped_regions:
        draw.rectangle(box, fill=0)
    bg = [p for p, keep in zip(image.crop(dock).getdata(), mask.crop(dock).getdata()) if keep]
    if len(bg) < 20:
        failures.append('Insufficient unobscured background samples')
    else:
        value = statistics.mean(sum(w * c for w, c in zip((.2126, .7152, .0722), p)) for p in bg)
        report['backgroundSRGBMean'] = round(value, 3)
        if value >= 180:
            failures.append('Native dock is light (background sRGB mean >= 180)')
    seen = {}
    for region, box in mapped_regions:
        key = (region['tabIndex'], region['role'])
        seen[key] = seen.get(key, 0) + 1
        crop = image.crop(box)
        values = [luminance(p) for p in crop.getdata()]
        cw, ch = crop.size
        border = [values[y * cw + x] for y in range(ch) for x in range(cw)
                  if x in (0, cw - 1) or y in (0, ch - 1)]
        local_bg = statistics.median(border)
        threshold = 3 if key[1] == 'icon' else 4.5
        contrasts = sorted(ratio(v, local_bg) for v in values)
        fraction = sum(c >= threshold for c in contrasts) / len(contrasts)
        p95 = contrasts[min(len(contrasts) - 1, int(len(contrasts) * .95))]
        candidate = .035 <= fraction <= .65
        report['regions'].append({'tabIndex': key[0], 'role': key[1], 'pixelFrame': box,
            'contrastP95Estimate': round(p95, 3), 'contrastingPixelFraction': round(fraction, 4),
            'requiredRatio': threshold, 'heuristicCandidate': candidate})
        if not candidate:
            failures.append(f'Tab {key[0]} {key[1]} lacks credible foreground structure/contrast')
    for tab in range(4):
        for role in ('icon', 'label'):
            count = seen.get((tab, role), 0)
            if count == 0:
                failures.append(f'Missing tab {tab} {role} region')
            elif count > 1:
                reviews.append(f'Tab {tab} {role} has {count} layered candidates; inspect original PNG')
    reviews.append('No trusted glyph masks: contrast estimates cannot establish readability; inspect original PNG')
    report['status'] = 'failed' if failures else 'needs_review'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=pathlib.Path)
    parser.add_argument('--report-only', action='store_true', help='Collection only; never implies acceptance')
    args = parser.parse_args()
    try:
        result = json.loads((args.directory / 'result.json').read_text(encoding='utf-8'))
        with Image.open(args.directory / 'simulator.png') as source:
            if source.format != 'PNG':
                raise ValueError('Original lossless compositor PNG required')
            image = source.convert('RGB')
        report = evaluate(image, result)
        if 'dockPixelFrame' in report:
            image.crop(report['dockPixelFrame']).save(args.directory / 'dock-preview.png')
    except (OSError, ValueError) as error:
        report = {'status': 'failed', 'failures': [str(error)], 'reviewReasons': []}
    (args.directory / 'appearance-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if args.report_only else (1 if report['status'] == 'failed' else 2)


if __name__ == '__main__':
    raise SystemExit(main())
