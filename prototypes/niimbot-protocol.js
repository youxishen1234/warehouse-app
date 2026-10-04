const SERVICE_UUID = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';
const CHARACTERISTIC_UUID = 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f';
const K3_MODEL_IDS = [4864, 4868];
const K3_HEAD_PIXELS = 656; // 203 dpi × 82 mm; verify margins with the physical K3.
const LABEL_WIDTH_PIXELS = 560; // 70 mm at 203 dpi.
const LABEL_HEIGHT_PIXELS = 800; // 100 mm at 203 dpi.

function packet(command, payload = []) {
  const bytes = [command & 255, payload.length & 255, ...payload.map(value => value & 255)];
  const checksum = bytes.reduce((value, byte) => value ^ byte, 0);
  return [0x55, 0x55, ...bytes, checksum, 0xaa, 0xaa];
}

function connectPacket() { return [0x03, ...packet(0xc1, [0x01])]; }

function parsePackets(buffer) {
  const packets = [];
  let rest = Array.from(buffer);
  while (rest.length >= 2) {
    let start = -1;
    for (let i = 0; i + 1 < rest.length; i++) {
      if (rest[i] === 0x55 && rest[i + 1] === 0x55) { start = i; break; }
    }
    if (start < 0) return { packets, rest: rest.slice(-1) };
    if (start > 0) rest = rest.slice(start);
    if (rest.length < 4) break;
    const length = rest[3];
    const packetLength = length + 7;
    if (rest.length < packetLength) break;
    const candidate = rest.slice(0, packetLength);
    const validTail = candidate.at(-2) === 0xaa && candidate.at(-1) === 0xaa;
    const check = candidate.slice(2, -3).reduce((value, byte) => value ^ byte, 0);
    if (!validTail || check !== candidate.at(-3)) { rest = rest.slice(1); continue; }
    packets.push({ command: candidate[2], data: candidate.slice(4, -3), raw: candidate });
    rest = rest.slice(packetLength);
  }
  return { packets, rest };
}

function encodeRow(row, index, headPixels = K3_HEAD_PIXELS) {
  const split = Math.floor(headPixels / 8 / 3);
  const counts = [0, 0, 0];
  row.forEach((byte, position) => {
    const segment = Math.min(2, Math.floor(position / split));
    let value = byte;
    while (value) { counts[segment] += value & 1; value >>>= 1; }
  });
  return packet(0x85, [(index >>> 8) & 255, index & 255, ...counts.map(n => Math.min(255, n)), 1, ...row]);
}

function encodeEmptyRows(start, count) {
  if (count < 1 || count > 255) throw new Error('空白行数量须为 1–255');
  return packet(0x84, [(start >>> 8) & 255, start & 255, count]);
}

function canvasToRows(canvas) {
  if (canvas.width !== LABEL_WIDTH_PIXELS || canvas.height !== LABEL_HEIGHT_PIXELS) {
    throw new Error('K3 标签图像必须是 560 × 800 像素');
  }
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const stride = canvas.width / 8;
  const rows = [];
  for (let y = 0; y < canvas.height; y++) {
    const row = new Array(stride).fill(0);
    for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      const luminance = rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114;
      if (luminance < 160) row[x >> 3] |= 0x80 >> (x & 7);
    }
    rows.push(row);
  }
  return rows;
}

function asUInt16(bytes) { return (bytes[0] << 8) | bytes[1]; }

module.exports = {
  SERVICE_UUID, CHARACTERISTIC_UUID, K3_MODEL_IDS, K3_HEAD_PIXELS,
  LABEL_WIDTH_PIXELS, LABEL_HEIGHT_PIXELS, packet, connectPacket,
  parsePackets, encodeRow, encodeEmptyRows, canvasToRows, asUInt16,
};
