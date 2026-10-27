# Bluetooth 630K Relay

The phone connects to the shop Windows PC over Bluetooth LE. The PC renders
the existing validated delivery-note job and prints it through its installed
EPSON LQ-630K USB driver.

This is not a Bluetooth module inside the LQ-630K. The printer still has no
Bluetooth radio. Phones without a Bluetooth-capable relay cannot print to it
when the relay is off.

## Transport

The Windows receiver advertises this custom GATT service:

| Purpose | UUID |
| --- | --- |
| Service | `8f0b5d8e-6b6d-42d9-9b80-5f3257a0f021` |
| Control write | `8f0b5d8e-6b6d-42d9-9b80-5f3257a0f022` |
| Relay info read | `8f0b5d8e-6b6d-42d9-9b80-5f3257a0f023` |
| Job data write | `8f0b5d8e-6b6d-42d9-9b80-5f3257a0f024` |
| Status notify/read | `8f0b5d8e-6b6d-42d9-9b80-5f3257a0f025` |

Control, data and status characteristics require an encrypted BLE link.
Pairing is handled by the operating system; the app does not use a separate
connection code. The relay info characteristic is readable before pairing and
must not contain credentials.

The relay info value is compact UTF-8 JSON:

```json
{"v":1,"relayId":"<stable uuid>","name":"630K","maxPayload":524288,"chunkSize":180}
```

The app scans only for the advertised service UUID. It never sends the server
pairing token, `agent.json`, a filesystem path, a command, HTML, or a printer
name to the relay.

## Job Transfer

Control commands and status values are compact UTF-8 JSON. The control
characteristic does not rely on platform-specific BLE long writes. Each
command is explicitly fragmented into the following binary frames, with all
multi-byte fields in network byte order:

| Byte offset | Field |
| --- | --- |
| 0 | Magic byte `0xB6` |
| 1 | Command ID, unsigned 16-bit |
| 3 | Complete JSON byte length, unsigned 16-bit |
| 5 | Payload byte offset, unsigned 16-bit |
| 7 | This frame's payload byte length, unsigned 16-bit |
| 9 | UTF-8 command bytes |

A complete command is 1 to 4096 bytes. Each frame fits within both `MTU - 3`
and the 512-byte ATT attribute limit, so an MTU of 23 carries at most 11
command bytes per frame. The phone
uses sequential write-with-response, one command ID per command, incremented
modulo 65536 within a connection. The relay assembles by BLE device session
and command ID, requires a consistent total and contiguous offsets, limits
unfinished assemblies to 16, and discards them after 30 seconds of inactivity.
Intermediate writes acknowledge receipt only; the JSON command is executed
once the final frame arrives. Complete unframed JSON commands remain accepted
for older clients when their platform can send the whole value in one write.

The last `commit` frame waits for the loopback receiver's journal response
before acknowledging the write; rendering and physical printing remain
asynchronous. The last `status` or `resolve` frame likewise waits for the
loopback operation and publishes its result before acknowledgement. The local
HTTP timeout is 10 seconds and the phone's control-write timeout is 15 seconds.

1. Send `{"v":1,"op":"hello"}` using the control framing above.
2. Write a begin command:

```json
{"v":1,"op":"begin","id":"remote-...","length":12345,"sha256":"<64 lowercase hex>","paper":"241-93"}
```

3. Send the job bytes on the data characteristic. Each write is a binary
   frame whose first four bytes are the zero-based chunk ordinal in network
   byte order, followed by at most `min(180, MTU - 7)` payload bytes. At MTU
   23 this is 16 payload bytes. Chunks must be contiguous; duplicate, reordered
   or oversized chunks are rejected. Begin, data and commit must come from
   the same BLE device session. A different begin cannot replace an active
   transfer, which expires after two minutes without valid data.

4. Write `{"v":1,"op":"commit","id":"remote-..."}`.
5. Poll the status characteristic and accept best-effort notifications until
   the job reaches `queued`, `failed` or `uncertain`. After reconnecting, query
   the same ID with `{"v":1,"op":"status","id":"remote-..."}` rather than
   starting a new transfer.

The transferred bytes are the UTF-8 encoding of one print-job envelope:

```json
{"v":1,"job":{"id":"remote-...","document":{},"settings":{}}}
```

The phone builds `document` and `settings` from the already saved note using
the same shape as the existing local print path. The PC adds its configured
printer name, applies `validatePrintJob()`, and reuses the existing
`createPersistentPrintService()` renderer. The phone cannot choose another
printer.

Every job is limited to 512 KiB and must match the declared byte length and
SHA-256 digest. Before forwarding, the helper also checks that `job.id` and
`job.settings.paper` match the begin command. Invalid complete transfers are
released without submission. The receiver's existing validation rejects JSON
nulls, unknown envelope fields and a different payload under an already used
job ID.

## Status

Status values contain a stable job ID and use the existing print semantics:

```json
{"v":1,"id":"remote-630k-example","status":"queued","message":"已进入打印队列","updatedAt":1790000000000,"confirmedPrintedAt":1790000001000}
```

Optional `code` values preserve the receiver's machine-readable error code.
`confirmedPrintedAt` records an explicit actual-paper confirmation and is
retained across later updates. Each complete status value is valid UTF-8 JSON
of at most 512 bytes; only the human-readable message is shortened to fit.
Reads use byte offsets, not character offsets, and keep a coherent snapshot
for each device session. Reading exactly the byte length returns an empty
value; a larger offset returns ATT `0x07`. Notifications may not fit a small
MTU, so clients must recover through a full status read rather than depend on
notification delivery.

Valid states:

- `received`: the helper is receiving bytes, or the receiver has persisted the
  submitted job. A transfer-stage value alone is not a durable receipt; wait
  for the commit write to finish and query the receiver.
- `processing`: the PC handed the job to the existing renderer.
- `queued`: Windows accepted the job. This does not prove paper came out.
- `failed`: the job failed before an unsafe print boundary; it may be retried.
- `uncertain`: the connection or renderer failed after printing might have
  started. It must never be retried automatically.

A duplicate begin is rejected while retaining the original job state. Protocol
errors never downgrade an existing transfer or durable job to `failed`. An
unknown ID is reported as `status:"failed",code:"JOB_NOT_FOUND"` without adding
it to the helper cache. Network errors and HTTP errors without an explicit
`safeToRetry:true` do not establish non-receipt. Known durable states are
retained; otherwise the result is `uncertain`. If a previously known ID is
missing from the receiver, the helper retains its state and reports
`RELAY_STATE_MISMATCH`, not a retryable not-found result.

The helper keeps at most 256 job states, preferentially evicting terminal rows;
the receiver's durable journal remains authoritative after reconnects or helper
restarts. A duplicate ID with different bytes is rejected by that journal. A
disconnect after `commit` remains unresolved until the app reconciles the same
ID. Resolve an actual-paper check using
`{"v":1,"op":"resolve","id":"remote-...","outcome":"printed"}` or the explicit
`"missing"` outcome; never retry an uncertain job automatically.

The phone persists `commitStarted:true` atomically before it sends `commit`.
It may clear an active pending job on authoritative `JOB_NOT_FOUND` only when
its saved attempt explicitly has `commitStarted:false`; missing legacy flags
remain conservative. If the helper still has the unfinished transfer, a
matching-device status query may release it only before commit and before a
durable receiver row exists. A different device cannot clear another
connection's transfer. After a helper restart the transfer cache is empty, so
the ordinary uncached not-found response handles that pre-commit recovery.
Once the helper validates commit, it marks its own job `uncertain` before
starting the HTTP request. Only an explicit safe rejection of that original
submission can make the unpersisted job `failed` again; a timeout or later
not-found cannot do so.

## Windows Ownership

The existing receiver process remains the only owner of the Windows spooler,
printer configuration and durable job journal. A Bluetooth helper may receive
bytes, but it must submit through the receiver rather than launching Electron
or printing directly.

The helper is started and stopped with the receiver and uses a loopback-only
capability chosen at process startup. It must not read or copy `agent.json`.
The receiver's watchdog and single-instance lock remain authoritative.

## Acceptance Boundary

Automated tests cover framing, size rules, hashes, replay, status transitions,
mobile state handling, and a simulated print service. They do not prove that a
phone can discover or pair with this Windows radio, that characteristic writes
cross the negotiated MTU, or that paper physically emerges.

Physical acceptance requires:

1. Pair the real phone with the Windows PC once.
2. Discover the advertised service and connect.
3. Send one saved 241 x 93 mm note.
4. Confirm exactly one physical sheet or form emerges.
5. Disconnect after commit and verify the app reports `uncertain`, not a
   duplicate retry.
6. Confirm the existing HTTPS fallback still works.
