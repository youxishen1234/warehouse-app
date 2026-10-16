# NIIMBOT iOS SDK

Unmodified files from the matched **SDKDemoOC/SDKDemoOC** set in the user-supplied
`IOS_4.1.1_20260729(1).zip`. `provenance.json` records the archive hash, per-file
hashes and sizes. The header's own version comment is 4.0.3 (20251226); do not
infer a binary version from the 4.1.1 archive name.

These are vendor-provided proprietary libraries, not project-authored code.
No Demo fonts, private keys or sample application code are included.

The `.a` libraries contain arm64 iOS **device** objects only. Xcode links them
through `OTHER_LDFLAGS[sdk=iphoneos*]`; simulator builds use the explicit unavailable
implementation in the new `NIIMBOTSDKAdapter.m`. Do not add them to an unconditional
Frameworks build phase. K3 does not need the B50/B11 JCLPAPI library.

Run `node scripts/verify-niimbot-sdk.cjs` to verify original bytes and target
architecture before building. This check only verifies vendor artifacts.
Run `node scripts/verify-label-print-ios.cjs` separately for the new bridge,
registration and conditional linking checks. Neither script compiles the native
code or verifies physical output. Use the existing iOS workflow for native builds
and the hot-update workflow for web publication. Physical Bluetooth printing
still requires a signed iPhone installation and K3 acceptance.
