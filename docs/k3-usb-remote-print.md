# K3 USB Remote Label Printing

The normal label path is: phone -> internet -> shop Windows PC -> USB COM3 ->
NIIMBOT K3. The phone does not connect to the printer over Bluetooth.

## Components

- H5: `pages/label-print` opens the computer USB page by default. The native
  iOS Bluetooth page remains available through `切换手机蓝牙打印`.
- Backend: `backend/remote-label-print.js` stores label profiles and jobs in a
  separate queue from the 630K delivery-note queue. It is wired by `team.js`
  after `remote-print.js`.
- Shop PC: `scripts/k3-remote-agent.cjs` claims one job only while K3 is ready,
  renders it in hidden Electron, sends rows over COM3, and reports the real
  printer outcome.
- Supervisor: `scripts/run-k3-remote-agent.ps1` restarts a stalled receiver.
  `scripts/install-k3-remote-task.ps1` registers `WarehouseK3RemotePrint`.

## Pairing and secrets

The phone uses the existing delivery-print client pairing for the label API.
The receiver registers its own label agent token once through the already
paired delivery agent. The label token is stored only in the receiver's
`k3-agent.json`; it is sent in `X-Print-Agent` and must never be committed or
placed in a URL or JSON body.

Create the receiver configuration from `k3-agent.json.template`. The template
contains no token; `autoRegister` fills the label token after the delivery
receiver is available.

## Completion contract

A label is complete only when the printer reports page progress/page evidence
and confirms `PrintEnd = 1`. Merely sending all rows is not success.

- `printed` -> server job `queued` with the printer page evidence.
- A lost PrintStart reply, a send failure after the session opened, or a
  missing PrintEnd becomes `uncertain`.
- `uncertain` jobs block the device queue and are never retried
  automatically; a person must confirm whether paper came out.
- A job that fails before PrintStart is safe to retry.

The receiver journals each job before printing. Replay only re-sends a missing
receipt; it never reprints a job whose bytes reached the printer.

## Acceptance performed 2026-10-24

- COM3, 115200 baud, K3 model 4864.
- One remote calibration label completed with an automatic `queued` receipt.
- Two consecutive remote calibration labels completed without manual
  confirmation; the receiver re-probed readiness after each job.
- Hardware evidence used a 70 x 100 mm profile with density 3 and margins
  0.6 / 0.5 / 0.5 / 0.5 mm. Physical size and position still need an operator
  check on the installed label stock.

No valid finished-product or paperboard record was available for a business
label acceptance run: the only product had no dimensions and no board batches
were present. Create or select a valid record and confirm the correct calibrated
paper profile before the first production label.

## Paperboard business template (70 × 100 mm portrait)

The paperboard receipt stores optional batch fields customerName, material, printPlate and printColor. These are batch text snapshots, not an inferred customer/order foreign key. Existing payable and production links are unchanged. Receipt create/edit and history reuse keep these fields; old batches may omit them.

Stock batch rows and batch details open the USB label page with the exact batch ID. The large-type template shows customer, board dimensions in cm, material/paper, plate name and color, then received quantity, receipt date, batch ID and a live batch QR. The phone fresh-reads before submitting, and the server rebuilds the allowed snapshot from saved batch data. Printing does not mutate stock or billing. The QR page exposes only label details and quantity movements.

The 70 x 100 mm paperboard template uses density 4, with a separate profile and calibration from the existing density 3 finished-product and other-size profiles. Saving a new density 4 profile never copies an earlier calibration. Its own calibration label must complete and be physically confirmed before production printing. The receiver passes the saved density to the printer before PrintStart.

For local receiver upgrades deploy scripts/k3-layout.cjs and scripts/k3-render.cjs together with the matching src/assets/label-fonts assets and license from the released commit. Keep the relative directory structure. Stop only the idle K3 receiver and preserve its config/journal; do not disturb the independent 630K delivery channel. Fonts are embedded locally into the label HTML without third-party font requests. Existing installed Bluetooth native binaries retain their original v1 snapshot whitelist; this business template is the PC/USB path.
