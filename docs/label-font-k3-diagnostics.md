# K3 font reproduction and acceptance

## Verified reproduction

Diagnostic run 39185140642 compiled the production renderer from commit
900d02e9452515f97e36f769fef1d1460aa72266 on Xcode 26.2 / iOS Simulator 26.2.
The original calibration and both business templates failed before any SDK call.
`CTFontGetGlyphsForCharacters` could not map U+00D7 (multiplication sign) or
U+00B2 (superscript two) in PingFangSC-Regular alone. CoreText shaped the same
original calibration text successfully using Helvetica fallback for these two
characters. Chinese characters and spaces were not the cause in that run.

The downloadable artifact SHA-256 was independently checked against GitHub's
artifact metadata before inspecting the JSON reports.

## Repair

- Shape the full field with CoreText fallback; inspect the resolved runs rather
  than expecting one base font to cover every UTF-16 code unit.
- Reject LastResort, visible missing glyphs and unsupported color-font runs.
- Wrap without dropping characters, using the same shaped line for measurement
  and rendering. Include typographic and ink bounds, padding and descent.
- Draw each line to an opaque grayscale PNG. Retain original text and field
  names in app-owned elements for regression checks.
- Pass the PNG through the original SDK's `DrawLableImage`, in millimetres,
  processing type 1 / threshold 127, with an empty font array. Keep QR codes
  and calibration borders as native SDK elements.
- Preserve the original vendor libraries and header, connection flow, task
  semantics, single-copy calibration and closed production gate.

The 300 dpi PNG sampling is intermediate rasterization, not a claim about K3
hardware DPI. The official SDK still composes its own label JSON and preview.

## Test data

`tests/label-font-fixtures.json` contains 12 text cases and two template cases.
The runner adds wrapping, default-ignorable, overflow and clipping checks.
The production renderer is compiled together with an SDK test double; it never
calls inventory APIs, connects to Bluetooth or submits a physical print.

Media: K3-I911020404, gap paper, 70 x 100 mm, density 3; margins top 5,
right 3, bottom 5, left 3 mm.

- Calibration: original Chinese text with multiplication sign and `g/m` plus
  superscript two, unchanged from the application.
- Finished product: ID 990001; test carton; 40 x 30 x 20 cm; weight 250;
  stock snapshot 10, unit supplied in the JSON fixture.
- Paperboard: BOARD-20261019-A1B2C3D4E5F6; 120 x 80 cm; B flute;
  test supplier; face paper 250 gsm.

Run `python scripts/test-label-font-ios.py --validate-fixtures` on any platform
for data validation only. Run without arguments on macOS with Xcode and an
iOS 26+ simulator for native regression tests. Windows data validation does
not count as a native pass. CI also syntax-checks the real Objective-C adapter
against the original device SDK header.

## Device acceptance still required

This is native Swift / Objective-C code. Build and reinstall the new IPA;
a web hot update alone does not replace the installed renderer.

On an iPhone connected to the K3, save the measured paper settings and submit
one calibration page. Verify Chinese, multiplication sign, superscript two,
orientation, baseline, all four borders, density and paper feed on real paper.
Inspect the official SDK preview and confirm it matches the printed text.
Then verify the two template previews, QR readability and correct resolver
records, copy counts, disconnect/reconnect and uncertain job recovery.

The native tests validate text preservation, PNG ink, empty-space handling,
image bounds, no edge clipping, supplementary characters, combining marks,
explicit unsupported cases and both templates reaching the SDK test double.
They do not prove real SDK image execution, Bluetooth, QR scan success or
physical output. Production printing remains disabled until those checks
have a source-controlled acceptance record.
