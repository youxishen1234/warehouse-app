"""Synthetic checks validate failure detection, not native glyph recognition."""
import copy
import importlib.util
import pathlib
import unittest
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location('dock_image', pathlib.Path(__file__).with_name('verify-native-dock-image.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(background=24, foreground=240, scale=1):
    image = Image.new('RGB', (400, 800), 'white')
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 700, 399, 799), fill=(background,) * 3)
    result = {'success': True, 'material': 'system-liquid-glass', 'screenshotReady': True,
              'windowBounds': {'x': 0, 'y': 0, 'width': 400, 'height': 800},
              'dockFrame': {'x': 0, 'y': 700, 'width': 400, 'height': 100}, 'imageRegions': []}
    for tab in range(4):
        for role, y, h in [('icon', 715, 24), ('label', 747, 14)]:
            x = 40 + tab * 100
            result['imageRegions'].append({'tabIndex': tab, 'role': role,
                'frame': {'x': x, 'y': y, 'width': 24, 'height': h}})
            # Interior cross simulates strokes; does not pretend to be a glyph mask.
            draw.line((x + 5, y + h // 2, x + 18, y + h // 2), fill=(foreground,) * 3, width=2)
            draw.line((x + 12, y + 3, x + 12, y + h - 4), fill=(foreground,) * 3, width=2)
    return image.resize((400 * scale, 800 * scale), Image.Resampling.NEAREST), result


class ImageChecks(unittest.TestCase):
    def test_clear_dark_candidate_still_needs_review(self):
        image, result = fixture()
        report = module.evaluate(image, result)
        self.assertEqual(report['failures'], [])
        self.assertEqual(report['status'], 'needs_review')

    def test_light_background_cannot_pass_as_bright_icon(self):
        image, result = fixture(235, 10)
        self.assertTrue(any('is light' in f for f in module.evaluate(image, result)['failures']))

    def test_dark_on_dark_fails(self):
        image, result = fixture(30, 8)
        self.assertEqual(module.evaluate(image, result)['status'], 'failed')

    def test_blank_and_uniform_images_fail(self):
        _, result = fixture()
        for color in (0, 24, 200, 255):
            self.assertEqual(module.evaluate(Image.new('RGB', (400, 800), (color,) * 3), result)['status'], 'failed')

    def test_scale_mapping(self):
        image, result = fixture(scale=3)
        self.assertEqual(module.evaluate(image, result)['failures'], [])

    def test_stale_rotation_fails(self):
        image, result = fixture()
        report = module.evaluate(image.transpose(Image.Transpose.ROTATE_90), result)
        self.assertTrue(any('aspect ratio' in f for f in report['failures']))

    def test_nonzero_window_origin(self):
        image, result = fixture()
        for rect in [result['windowBounds'], result['dockFrame']] + [r['frame'] for r in result['imageRegions']]:
            rect['x'] += 15
            rect['y'] += 30
        self.assertEqual(module.evaluate(image, result)['failures'], [])

    def test_missing_invalid_and_outside_geometry(self):
        image, result = fixture()
        for bad in ({}, {'x': 0, 'y': 900, 'width': 100, 'height': 50},
                    {'x': float('nan'), 'y': 700, 'width': 400, 'height': 100}):
            item = copy.deepcopy(result)
            item['dockFrame'] = bad
            self.assertEqual(module.evaluate(image, item)['status'], 'failed')

    def test_duplicate_layers_report_review(self):
        image, result = fixture()
        result['imageRegions'].append(copy.deepcopy(result['imageRegions'][0]))
        report = module.evaluate(image, result)
        self.assertTrue(any('layered candidates' in r for r in report['reviewReasons']))
        self.assertEqual(report['status'], 'needs_review')

    def test_missing_label_or_ready_fails(self):
        image, result = fixture()
        result['imageRegions'].pop()
        result['screenshotReady'] = False
        self.assertEqual(module.evaluate(image, result)['status'], 'failed')

    def test_122_original_is_never_accepted(self):
        directory = pathlib.Path(__file__).resolve().parent.parent / 'release/ui-native-122-image-check'
        if not (directory / 'simulator.png').exists():
            self.skipTest('Build 122 original PNG not present in this checkout')
        import json
        result = json.loads((directory / 'result.json').read_text(encoding='utf-8'))
        with Image.open(directory / 'simulator.png') as source:
            # Old metadata lacks the reliable new geometry contract: fail closed.
            self.assertEqual(module.evaluate(source, result)['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
