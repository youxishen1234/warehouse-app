// Deterministic printer simulator used by the offline self-test. It parses the
// same wire frames the real printer does and answers with realistic timing
// sequences, including the "stale 100%" trap after PageEnd.

const { COMMAND, FrameParser, frame } = require('./k3-protocol.cjs');

class FakeK3 {
  constructor({
    modelId = 4864, pagesBefore = 2, staleProgress = 100,
    emitPageEvent = true, failWith = null, now = () => Date.now(),
    pageMode = 'increment', confirmPrintEnd = true, feedProgressOnComplete = 100,
  } = {}) {
    this.parser = new FrameParser();
    this.modelId = modelId;
    this.page = pagesBefore;
    this.progress = staleProgress;
    this.feed = staleProgress;
    this.emitPageEvent = emitPageEvent;
    this.failWith = failWith;
    this.now = now;
    this.commands = [];
    this.rows = [];
    this.emptyRows = [];
    this.checks = [];
    this.started = false;
    this.pageEndedAt = 0;
    this.polls = 0;
    this.finished = false;
    // "job" models firmware that restarts its page number for every job;
    // "increment" models a lifetime counter.
    this.pageMode = pageMode;
    this.confirmPrintEnd = confirmPrintEnd;
    this.feedProgressOnComplete = feedProgressOnComplete;
  }

  response(command, payload) {
    return frame(command, payload);
  }

  /** Feed serial bytes and return what the printer would write back. */
  receive(buffer) {
    const out = [];
    for (const packet of this.parser.push(buffer)) {
      this.commands.push({ command: packet.command, payload: packet.payload.toString('hex') });
      if (this.failWith && packet.command === this.failWith.at) {
        out.push(this.response(0xdb, [this.failWith.code]));
        continue;
      }
      switch (packet.command) {
        case COMMAND.CONNECT:
          out.push(this.response(0xc2, [3]));
          break;
        case COMMAND.PRINTER_INFO: {
          const key = packet.payload[0];
          const values = {
            1: [3], 2: [2], 3: [1],
            8: this.modelId === 4864 ? [0x13] : [this.modelId >> 8, this.modelId & 0xff],
            9: [5, 7],
          };
          out.push(this.response(0x40 + key, values[key] || [0]));
          break;
        }
        case COMMAND.PRINTER_STATUS_DATA:
          out.push(this.response(0xb5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 5]));
          break;
        case COMMAND.HEARTBEAT:
          out.push(this.response(0xd9, [0, 0, 4, 24, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2]));
          break;
        case COMMAND.PRINT_STATUS: {
          this.polls += 1;
          out.push(this.response(0xb3, this.statusPayload()));
          break;
        }
        case COMMAND.SET_DENSITY:
          out.push(this.response(0x31, [packet.payload[0]]));
          break;
        case COMMAND.SET_LABEL_TYPE:
          out.push(this.response(0x33, [packet.payload[0]]));
          break;
        case COMMAND.PRINT_START:
          this.started = true;
          this.progress = 0;
          this.feed = 0;
          out.push(this.response(0x02, [1]));
          break;
        case COMMAND.PAGE_START:
          out.push(this.response(0x04, [1]));
          break;
        case COMMAND.SET_PAGE_SIZE:
          out.push(this.response(0x14, [1]));
          break;
        case COMMAND.PRINT_BITMAP_ROW:
          this.rows.push(packet.payload.toString('hex'));
          break;
        case COMMAND.PRINT_EMPTY_ROW:
          this.emptyRows.push(packet.payload.toString('hex'));
          break;
        case COMMAND.PRINT_CHECK_LINE:
          this.checks.push(packet.payload.toString('hex'));
          out.push(this.response(0xd3, [1]));
          break;
        case COMMAND.PAGE_END:
          this.pageEndedAt = this.now();
          this.progress = 100;
          this.feed = this.feedProgressOnComplete;
          this.page = this.pageMode === 'job' ? 1 : this.page + 1;
          out.push(this.response(0xe4, [1]));
          if (this.emitPageEvent) out.push(frame(0xe0, [0, this.page]));
          this.finished = true;
          break;
        case COMMAND.PRINT_END:
          if (this.ended === undefined) this.ended = 0;
          this.ended += 1;
          out.push(this.response(0xf4, [this.finished && this.confirmPrintEnd ? 1 : 0]));
          break;
        case COMMAND.CANCEL_PRINT:
          this.finished = false;
          out.push(this.response(0xd0, [1]));
          break;
        default:
          out.push(this.response(0x00, []));
      }
    }
    return Buffer.concat(out);
  }

  statusPayload() {
    if (this.started && !this.finished) {
      // While rows are streaming the page has not advanced; progress reflects it.
      return [0, this.page, 40, 0, 0, 0, 0, 0, 0, 0];
    }
    return [this.page >> 8 & 0xff, this.page & 0xff, this.progress, this.feed, 0, 0, 0, 0, 0, 0];
  }
}

/** Fake transport wired straight to a FakeK3. */
class FakeTransport {
  constructor(printer, { dropFirst = 0 } = {}) { this.printer = printer; this.dropFirst = dropFirst; }
  async write(packet) {
    if (this.dropFirst > 0) { this.dropFirst -= 1; return Buffer.alloc(0); }
    return this.printer.receive(packet);
  }
  async writeOnly(packet) { this.printer.receive(packet); }
}

module.exports = { FakeK3, FakeTransport };
