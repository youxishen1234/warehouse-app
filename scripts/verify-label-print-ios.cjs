const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Static configuration checks; Xcode and K3 physical acceptance remain separate gates.
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const count = (text, token) => text.split(token).length - 1;
const project = read('ios/App/App.xcodeproj/project.pbxproj');
const sources = project.split('/* Begin PBXSourcesBuildPhase section */')[1]?.split('/* End PBXSourcesBuildPhase section */')[0];
assert.ok(sources, 'Xcode Sources phase exists');
const required = ['OfficialLabelPrinterPlugin.swift', 'NIIMBOTSDKAdapter.m', 'LabelTemplateRenderer.swift'];
for (const name of required) {
  assert.ok(fs.existsSync(path.join(root, 'ios/App/App', name)), name + ' exists');
  assert.equal(count(sources, name + ' in Sources'), 1, name + ' compiled exactly once');
  assert.ok(project.includes('path = ' + name + ';'), name + ' file reference');
}
for (const name of ['SGNiimbotSDK.mm', 'NiimbotOfficialPrinterPlugin.swift']) {
  assert.ok(!project.includes(name), 'legacy bridge excluded: ' + name);
}
const registration = read('ios/App/App/NativeGlassTabBar.swift');
assert.equal(count(registration, 'registerPluginInstance(OfficialLabelPrinterPlugin())'), 1, 'new bridge registered once');
assert.ok(!/registerPluginInstance[(]Niimbot(?:Official)?PrinterPlugin[(]/.test(registration), 'legacy printers are not registered');
assert.ok(read('ios/App/App/App-Bridging-Header.h').includes('#import "NIIMBOTSDKAdapter.h"'));
assert.equal(count(project, 'SWIFT_OBJC_BRIDGING_HEADER = "App/App-Bridging-Header.h"'), 2, 'Debug and Release bridging header');

const deviceFlags = project.split('"OTHER_LDFLAGS[sdk=iphoneos*]" = (').slice(1).map(section => section.split(');')[0]);
assert.equal(deviceFlags.length, 2, 'device-only SDK flags in Debug and Release');
for (const flags of deviceFlags) {
  for (const token of ['JCAPI.a', 'libSkiaRenderLibrary.a', '-ObjC', '-lc++', '-lbz2', '-liconv', '-lz', 'AVFoundation', 'CoreMedia', 'ExternalAccessory']) {
    assert.ok(flags.includes(token), 'device linker input: ' + token);
  }
}
assert.equal(count(project, 'Vendor/NIIMBOT/JCAPI.a'), 2, 'vendor SDK not linked unconditionally');
assert.equal(count(project, 'Vendor/NIIMBOT/libSkiaRenderLibrary.a'), 2, 'Skia not linked unconditionally');
const adapter = read('ios/App/App/NIIMBOTSDKAdapter.m');
assert.match(adapter, /#if !TARGET_OS_SIMULATOR[^#]+#import "Vendor[/]NIIMBOT[/]JCAPI.h"[^#]+#endif/, 'device header guarded from simulator');
assert.match(adapter, /#if TARGET_OS_SIMULATOR[^#]+return NO;/, 'simulator explicitly unsupported');
assert.ok(adapter.includes('setPrintWithCache:NO'), 'cache disabled per job');
assert.ok(adapter.includes('setTotalQuantityOfPrints:copies'), 'total set from frozen copies');
assert.ok(adapter.includes('withOnePageNumbers:(int)copies'), 'commit uses frozen copies');
assert.ok(adapter.includes('initImageProcessing:nil'), 'system font pipeline initialized without an empty path');
for (const encoding of ['png-rgba', 'png-argb', 'jpeg', 'raw-rgba', 'raw-argb']) {
  assert.ok(adapter.includes(encoding), 'label image encoding fallback exists: ' + encoding);
}
assert.ok(adapter.includes('DrawLableImage:x') && adapter.includes('withImageProcessingType:1 withImageProcessingValue:127'), 'official SDK consumes text PNGs');
assert.ok(adapter.includes('fontArray:@[]'), 'no SDK font lookup when text is rasterized');
assert.ok(!adapter.includes('drawLableText:') && !adapter.includes('withFontFamily:'), 'no second font engine for shaped text');
for (const code of ['DRAWING_ELEMENT_INVALID', 'DRAWING_IMAGE_DATA_MISSING', 'DRAWING_IMAGE_REJECTED', 'DRAWING_QR_DATA_MISSING', 'DRAWING_QR_REJECTED', 'DRAWING_LINE_REJECTED', 'SDK_JSON_EMPTY']) {
  assert.ok(adapter.includes(code), 'specific drawing error remains observable: ' + code);
}
assert.ok(!adapter.includes('@"DRAWING_FAILED"'), 'generic drawing failures are removed');
const renderer = read('ios/App/App/LabelTemplateRenderer.swift');
assert.ok(renderer.includes('CTLineCreateWithAttributedString') && renderer.includes('CTLineDraw(line.shaped, context)'), 'same CoreText line shaped and drawn');
assert.ok(!renderer.includes('CTFontGetGlyphsForCharacters'), 'single-font UTF-16 guard removed');
const calibrationStart = renderer.indexOf('static func calibration(');
assert.ok(calibrationStart >= 0, 'calibration renderer exists');
const bitmapStart = renderer.indexOf('static func calibrationBitmap(', calibrationStart);
assert.ok(bitmapStart > calibrationStart, 'direct calibration bitmap exists');
const calibration = renderer.slice(calibrationStart, bitmapStart);
assert.ok(!calibration.includes('"type": "line"'), 'calibration never calls the rejected line primitive');
assert.equal(count(calibration, 'borderImage('), 4, 'calibration border uses four image strips');
assert.ok(!/"w": w, "h": h/.test(calibration), 'calibration never submits a full-page image element');
assert.ok(!calibration.includes('context.stroke(CGRect('), 'calibration no longer rasterizes one full-page bitmap');
assert.match(calibration, /heightMm: lineHeight/, 'calibration text stays on the per-line rasterizer path');
const bitmap = renderer.slice(bitmapStart, renderer.indexOf('\n    }\n}', bitmapStart));
assert.ok(bitmap.includes('context.stroke(CGRect('), 'direct bitmap draws the calibration border');
assert.ok(bitmap.includes('CTLineDraw(line.shaped, context)'), 'direct bitmap draws shaped text');
assert.ok(renderer.includes('k3PixelsPerMm = 8.0'), 'K3 bitmap uses its native 8 dots/mm');
assert.ok(bitmap.includes('profile.widthMm * LabelTextRasterizer.k3PixelsPerMm'), 'bitmap covers the full K3 page width');
assert.ok(bitmap.includes('profile.heightMm * LabelTextRasterizer.k3PixelsPerMm'), 'bitmap covers the full K3 page height');
const pluginSource = read('ios/App/App/OfficialLabelPrinterPlugin.swift');
assert.match(pluginSource, /LabelTemplateRenderer[.]calibrationBitmap[(]media[)]/, 'plugin submits a direct calibration bitmap');
assert.match(pluginSource, /sdk[.]printBitmap[(]/, 'plugin uses the direct bitmap channel');
assert.ok(adapter.includes('print:binary dataWidth:(unsigned int)width dataHeight:(unsigned int)height'), 'adapter uses JCAPI bitmap printing');
assert.ok(adapter.includes('withDashLine:NO withComplete:'), 'bitmap print has explicit dash-line setting');
assert.ok(adapter.includes('NIIMBOTBitmapBytes(image, YES)'), 'bitmap is composited as ARGB before binarization');
assert.ok(adapter.includes('pixel[1] * 30 + pixel[2] * 59 + pixel[3] * 11'), 'ARGB channels drive BT.601 luma');
assert.ok(adapter.includes('dst[i * 4] = pixel[0]'), 'source alpha is preserved');
assert.ok(adapter.includes('expectedWidth') && adapter.includes('widthMm * 8.0'), 'bitmap width is checked against K3 native pixels');
assert.ok(adapter.includes('finishPendingBitmapIfComplete') && adapter.includes('latestPrintCount < 1'), 'endPrint waits for printer count');
const activeNames = [...sources.matchAll(/[/][*] ([^*]+) in Sources [*][/]/g)].map(match => match[1]);
for (const name of activeNames) {
  if (name === 'NIIMBOTSDKAdapter.m') continue;
  const source = read('ios/App/App/' + name);
  assert.ok(!/(?:#import|#include).*JCAPI|[[]JCAPI |JCAPI[.]/.test(source), name + ' must not own JCAPI');
}
const plugin = read('ios/App/App/OfficialLabelPrinterPlugin.swift');
assert.match(plugin, /jsName *= *"OfficialLabelPrinter"/, 'Capacitor contract');
assert.match(plugin, /productionEnabled *= *false/, 'production gate stays closed until K3 acceptance');
assert.ok(plugin.includes('PRODUCTION_NOT_ACCEPTED'), 'stable closed-gate error');
for (const legacy of ['NiimbotOfficialPrinterPlugin.swift', 'SGNiimbotSDK.h', 'SGNiimbotSDK.mm']) {
  assert.ok(!fs.existsSync(path.join(root, 'ios/App/App', legacy)), 'legacy printer source is removed: ' + legacy);
}
const info = read('ios/App/App/Info.plist');
for (const key of ['NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription']) {
  assert.ok(info.includes('<key>' + key + '</key>'), 'Bluetooth explanation: ' + key);
  assert.match(info.split('<key>' + key + '</key>')[1], /^[^<]*<string>[^<]+<[/]string>/);
}
console.log('New label iOS source integration verified. This does not compile/link native code or prove physical printing; production remains gated.');
