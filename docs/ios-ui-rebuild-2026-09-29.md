# iOS 1.1.4 UI and tab navigation repair

## User-visible changes

- Inbound: blue receipt header with live order amount, supplier/date/order
  fields, expandable delivery details, grouped product lines and a submit
  button above the dock. Existing posting, over-receipt confirmation,
  supplier accounting, CSV and void operations are retained.
- Outbound: teal dispatch header, customer card, paired quantity/price
  fields, stock preview and readable recent records. Restore the corrupted
  void-action label; retain duplicate-submit and stock guards.
- Mine: light workspace cards and grouped device settings, real authenticated
  connection checks, correct custom-copy label, separate IPA/web-update labels.
- Home: remove the global card/gradient overrides that left white labels
  on white cards. Correct the CSS Module scope and width of the injected
  corrugated-calculator shortcut. Keep all existing feature routes.

## Interaction repair

- Native iOS 26 continues to use UIKit's actual Liquid Glass tab control.
  No custom pan recognizer or imitation view replaces the native control.
- Native requests carry a sequence identifier. Late route acknowledgments
  cannot reset an in-flight selection. Apply selection only when changed,
  with explicit failure/timeout reconciliation.
- JavaScript serializes navigation and retains the newest requested tab.
  Do not acknowledge old routes during navigation; deduplicate stable state.
- Web/older-iOS fallback caches geometry during dragging and cancels when
  the finger leaves the dock vertically.
- Dock clearances use unscaled CSS pixels; Taro previously scaled the
  intended offset and allowed the submit button to overlap the dock.

## Additional regression discovered

The orders page supplied a new loader function to useRemoteData on every
render. Each response triggered another render and another pair of orders/
customers requests. WebKit stayed in loading state and produced request
failures. Memoize the loader and let the hook own its initial fetch.
Keep the shared hook's dependency-driven filtering behavior unchanged.

## Verification

- TypeScript and ESLint; backend node --test: 106 passed, 2 existing skips.
- Artifact/unit tests: 70 passed, including queued selection, failure,
  modal blocking and real sequence-guard contracts.
- H5 production build; existing bundle-size warnings remain.
- Chromium/WebKit: all four pages at 320, 390 and 430 CSS pixels, including
  dark system preference; screenshots and contrast/overflow/clearance checks.
- Chromium/WebKit: native bridge handshake, rapid selection, gesture
  cancellation, keyboard navigation, calculator and rotation.
- Isolated real backend: posting, CSV export, void/stock restoration,
  duplicate submit, 18 routes and 390/1280 viewport widths.
- Failed form initialization and retry remain covered.
- Live read-only CORS checks against production in WebKit and Chromium,
  including repeated sync polling. No production business records mutated.
- Orders browser regression checks request counts remain stable when the
  draft form is edited.

Native compilation and simulator acceptance run in the GitHub iOS workflow.
The release gate requires an iOS 26+ runtime and a system-liquid-glass result;
an older runtime passing with web-glass does not count as native acceptance.
The simulator also checks rapid native requests after a WebView reload.
These tests do not establish physical-iPhone finger-gesture acceptance.
Swift changes require the new IPA; a web hot update alone cannot replace
the installed native controller.

## Native iOS 26 regression found during acceptance

Builds 113 and 114 failed the native gate. Build 114's trace proves that
setting UITabBarController.selectedIndex programmatically reenters the new
didSelectTab delegate. One inbound selection generated requests 1 and 2,
then dispatched 2 before 1; the web layer correctly acknowledged the last
request (1), while native was waiting for 2 and reverted after its timeout.
Guard programmatic assignments so only user selections initiate requests.
Keep UIKit's native gesture recognizers and material. Apply the approved
dark appearance at the tab-controller boundary, with a light business WebView.

The simulator gate exercises all four real pages, reload, rapid queued
selection and return home; screenshots of each accepted page are archived.
Build 115 passes all native navigation steps. Its compositor screenshot still
shows a light dock despite the tab bar reporting a dark trait. Keep the native
tab hosts dark, apply the light override only to the business WebView, and set
UIKit's black bar style. A compositor-image luminance check now blocks light
dock regressions, instead of trusting the trait flag alone. Final marketing
version is 1.1.4; the compact dock preview is available in CI annotations.

Build 116 passed native navigation, then failed installing Pillow into the
Homebrew-managed Python environment. Use an isolated virtual environment.
Its compositor image also remained light: keep the entire native hierarchy
and window dark, and use CSS color-scheme: light for business form controls.
The actual screenshot gate remains mandatory before publishing.
