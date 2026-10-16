# NIIMBOT K3 Bluetooth Printing

New iOS shells use the supplied official NIIMBOT SDK through
`OfficialLabelPrinterPlugin`. Protocol tests and simulated printer tests do not
prove physical K3 compatibility.

The user supplied the official iOS SDK package on 2026-10-09. Its contents and
K3 BLE support have been reviewed and the matched Demo library set is integrated. See
[the SDK intake review](niimbot-official-sdk-4.1.1-review.md) for the package
location, API mapping, and differences between the two bundled library sets.

## Scope

- iOS Capacitor app only, using CoreBluetooth. Safari and the Windows browser
  keep system printing; they do not get a fake Bluetooth connection button.
- Official SDK scanning selects K3 BLE names and connects by the SDK's device name.
  The separately listed K3_W SPP/Wi-Fi variant is not advertised as BLE.
- Legacy community model IDs: 4864 (K3), 4865 (K3 Wi-Fi variant), 4868 (K3 ITD).
- One monochrome 70 x 100 mm gap-label per action, at 560 x 800 pixels.
- Finished-product and paperboard labels share the same print transport.
- Search is user-initiated, permission-aware, and restricted to NIIMBOT/K3 names.
  Connection succeeds only after the expected GATT characteristic is notifying.
- Closing the label page disconnects. A failed print cancels and disconnects;
  do not automatically retry a physical print, since it can duplicate a label.

## Official SDK

The iOS bridge renders the existing 560 x 800 PNG into a 70 x 100 mm SDK
drawing board, starts one gap-label job, submits one copy, waits for the
SDK's printed count, and resolves only after `endPrint` succeeds. Errors and
timeouts cancel/disconnect without an automatic retry. Generation tokens
discard callbacks from previous scans, connections and jobs. Simulator
builds do not link the device-only SDK and report printing unavailable.

Run `node scripts/verify-niimbot-sdk.cjs` to verify vendor hashes and targets,
then `node --test tests/label-domain.test.cjs tests/label-fresh-read.test.cjs`
and `node tests/label-resolver-browser.cjs` against isolated built label assets.
Xcode and physical acceptance remain separate verification steps.

## Historical Protocol Notes

The following references document the earlier community-protocol investigation;
the current iOS bridge uses the supplied official SDK and does not bundle that
protocol implementation.

Primary community sources reviewed on 2026-10-04:

- https://github.com/eigger/hass-niimbot (MIT)
- https://github.com/eigger/hass-niimbot/blob/master/docs/protocol.md
- https://github.com/eigger/hass-niimbot/blob/master/docs/printing.md
- https://github.com/eigger/hass-niimbot/blob/master/docs/device-info.md
- https://github.com/eigger/hass-niimbot/blob/master/custom_components/niimbot/niimprint/model.py

No third-party driver code is bundled or executed. Our implementation uses
documented framing, commands and model metadata:

1. Subscribe, then handshake and read model info.
2. Read density (response 0x41); set density and gap-label type.
3. V4 print start (7 bytes, response 0x02), page start (0x04), page dimensions
   (6 bytes, response 0x14). Do not use D11-only PrintClear.
4. Transfer MSB-first rows with native flow control and 200-row checkpoints.
5. End the page; wait for page notification or fresh completed print/feed progress.
   PrintEnd is a final command, not a guessed "printed" flag.

The community model library gives a 656-pixel head; the 82 mm advertised width
is not by itself proof of usable margins. The 560-pixel label leaves extra room.
Real hardware must verify positioning, DPI, paper type, QR scanning and feed.

## Verification

Use unique build directories in this shared workspace:

```powershell
$env:TARO_OUTPUT_DIR='release/k3-check/dist'
$env:WAREHOUSE_BUILD_STAGE='release/k3-check/stage'
$env:TARO_PUBLIC_PATH='./'
npm run build:h5
$env:NAV_WEB_DIR=$env:TARO_OUTPUT_DIR
$env:LABEL_RESOLVER_CHECK_DIR='release/k3-check/labels'
node --test tests/label-domain.test.cjs tests/label-fresh-read.test.cjs
node tests/label-resolver-browser.cjs
```

The simulator cannot perform a real Bluetooth print. Build the native package
through `.github/workflows/build-ios.yml`; it is unsigned and must be signed for
installation. A hot update cannot add CoreBluetooth to an old native shell.
Hot updates must use `.github/workflows/publish-hotupdate.yml` and the source gate.

## Device Acceptance

1. Disconnect the K3 from the official phone/desktop app; switch it on with a
   real 70 x 100 mm gap-label roll installed.
2. Install the newly signed iOS build. Open Home > Business Center > Label Print.
3. Allow Bluetooth, search, select the K3, connect. Check the exact device name.
4. Print one finished-product label and one paperboard label. Check 70 x 100 mm
   sizing, complete text, positioning and the scanned QR fields.
5. Test cover-open, paper-out, reconnect, Bluetooth-off and cancelled job handling.

Only mark real printing verified after this acceptance. A green connection in
NIIMBOT desktop software does not verify this app's connection or print sequence.
