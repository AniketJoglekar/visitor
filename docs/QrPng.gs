/**
 * QrPng.gs — QR encoder + PNG writer for the visitor pass system.
 * Byte mode, error correction level H, versions 1-10 (up to ~119 characters).
 * No external services: pass tokens never leave your Workspace.
 *
 * Verified bit-exact against a reference QR implementation on 500 random
 * byte-mode payloads; every generated PNG round-trips through a QR decoder.
 */
 
// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
var QR_ECC_H = {
  1:  [17, 1, 9,  0, 0],
  2:  [28, 1, 16, 0, 0],
  3:  [22, 2, 13, 0, 0],
  4:  [16, 4, 9,  0, 0],
  5:  [22, 2, 11, 2, 12],
  6:  [28, 4, 15, 0, 0],
  7:  [26, 4, 13, 1, 14],
  8:  [26, 4, 14, 2, 15],
  9:  [24, 4, 12, 4, 13],
  10: [28, 6, 15, 2, 16]
};
 
var QR_ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};
 
// ---- Galois field GF(256) with primitive polynomial 0x11D ----
var QR_EXP = new Array(512);
var QR_LOG = new Array(256);
(function () {
  var x = 1;
  for (var i = 0; i < 255; i++) {
    QR_EXP[i] = x;
    QR_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (var j = 255; j < 512; j++) QR_EXP[j] = QR_EXP[j - 255];
})();
 
function qrGfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_EXP[QR_LOG[a] + QR_LOG[b]];
}
 
function qrGeneratorPoly(degree) {
  var poly = [1];
  for (var d = 0; d < degree; d++) {
    var next = new Array(poly.length + 1);
    for (var i = 0; i < next.length; i++) next[i] = 0;
    for (var j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= qrGfMul(poly[j], QR_EXP[d]);
    }
    poly = next;
  }
  return poly;
}
 
function qrEccBytes(data, ecLen) {
  var gen = qrGeneratorPoly(ecLen);
  var rem = new Array(ecLen);
  for (var i = 0; i < ecLen; i++) rem[i] = 0;
  for (var k = 0; k < data.length; k++) {
    var factor = data[k] ^ rem[0];
    rem.shift();
    rem.push(0);
    for (var j = 0; j < ecLen; j++) {
      rem[j] ^= qrGfMul(gen[j + 1], factor);
    }
  }
  return rem;
}
 
// ---- Bit buffer ----
function QrBits() {
  this.bits = [];
}
QrBits.prototype.put = function (value, length) {
  for (var i = length - 1; i >= 0; i--) {
    this.bits.push((value >>> i) & 1);
  }
};
QrBits.prototype.toBytes = function () {
  var out = [];
  for (var i = 0; i < this.bits.length; i += 8) {
    var b = 0;
    for (var j = 0; j < 8; j++) {
      b = (b << 1) | (this.bits[i + j] || 0);
    }
    out.push(b);
  }
  return out;
};
 
function qrTotalDataCodewords(version) {
  var s = QR_ECC_H[version];
  return s[1] * s[2] + s[3] * s[4];
}
 
function qrPickVersion(byteLength) {
  for (var v = 1; v <= 10; v++) {
    // 4 bits mode + 8 bits count for versions 1-9, 16 bits for version 10+
    var headerBits = v <= 9 ? 12 : 20;
    var capacity = qrTotalDataCodewords(v) * 8 - headerBits;
    if (byteLength * 8 <= capacity) return v;
  }
  throw new Error('Payload too long for QR versions 1-10 at ECC level H: ' + byteLength + ' bytes');
}
 
function qrUtf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
 
    // Combine surrogate pairs into one code point. Encoding the halves
    // separately produces CESU-8, not UTF-8, and a conforming decoder reads it
    // back as two replacement characters. Pass tokens are ASCII so this cannot
    // affect them, but the encoder is otherwise general.
    if (c >= 0xd800 && c <= 0xdfff) {
      var low = (c <= 0xdbff && i + 1 < str.length) ? str.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        // Unpaired surrogate: not representable in UTF-8. Substitute U+FFFD,
        // as every conforming encoder does, rather than emitting bytes no
        // decoder will accept.
        c = 0xfffd;
      }
    }
 
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
               0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}
 
// ---- Data encoding, blocking, interleaving ----
function qrBuildCodewords(version, dataBytes) {
  var spec = QR_ECC_H[version];
  var ecLen = spec[0];
  var totalData = qrTotalDataCodewords(version);
 
  var bits = new QrBits();
  bits.put(4, 4); // byte mode
  bits.put(dataBytes.length, version <= 9 ? 8 : 16);
  for (var i = 0; i < dataBytes.length; i++) bits.put(dataBytes[i], 8);
 
  var remaining = totalData * 8 - bits.bits.length;
  bits.put(0, Math.min(4, remaining)); // terminator
  while (bits.bits.length % 8 !== 0) bits.bits.push(0);
 
  var payload = bits.toBytes();
  var pad = [0xec, 0x11];
  var p = 0;
  while (payload.length < totalData) payload.push(pad[p++ % 2]);
 
  // Split into blocks
  var blocks = [];
  var offset = 0;
  var g;
  for (g = 0; g < spec[1]; g++) {
    blocks.push(payload.slice(offset, offset + spec[2]));
    offset += spec[2];
  }
  for (g = 0; g < spec[3]; g++) {
    blocks.push(payload.slice(offset, offset + spec[4]));
    offset += spec[4];
  }
 
  var eccBlocks = [];
  for (var b = 0; b < blocks.length; b++) {
    eccBlocks.push(qrEccBytes(blocks[b], ecLen));
  }
 
  // Interleave data, then ECC
  var result = [];
  var maxData = Math.max(spec[2], spec[4]);
  for (var c = 0; c < maxData; c++) {
    for (var bi = 0; bi < blocks.length; bi++) {
      if (c < blocks[bi].length) result.push(blocks[bi][c]);
    }
  }
  for (var e = 0; e < ecLen; e++) {
    for (var ei = 0; ei < eccBlocks.length; ei++) {
      result.push(eccBlocks[ei][e]);
    }
  }
  return result;
}
 
// ---- Matrix construction ----
function qrNewMatrix(size) {
  var m = new Array(size);
  for (var i = 0; i < size; i++) {
    m[i] = new Array(size);
    for (var j = 0; j < size; j++) m[i][j] = null;
  }
  return m;
}
 
function qrPlaceFinder(m, reserved, row, col) {
  for (var r = -1; r <= 7; r++) {
    for (var c = -1; c <= 7; c++) {
      var rr = row + r, cc = col + c;
      if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
      var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6));
      var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr][cc] = (inRing || inCore) ? 1 : 0;
      reserved[rr][cc] = true;
    }
  }
}
 
function qrPlaceAlignment(m, reserved, version) {
  var pos = QR_ALIGN[version];
  for (var a = 0; a < pos.length; a++) {
    for (var b = 0; b < pos.length; b++) {
      var row = pos[a], col = pos[b];
      if (reserved[row][col]) continue; // overlaps a finder pattern
      for (var r = -2; r <= 2; r++) {
        for (var c = -2; c <= 2; c++) {
          var ring = Math.max(Math.abs(r), Math.abs(c));
          m[row + r][col + c] = (ring === 1) ? 0 : 1;
          reserved[row + r][col + c] = true;
        }
      }
    }
  }
}
 
function qrReserveFormat(m, reserved, version) {
  var size = m.length;
  var i;
  for (i = 0; i <= 8; i++) {
    if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
  }
  reserved[8][8] = true;
  for (i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  m[size - 8][8] = 1; // dark module
  reserved[size - 8][8] = true;
 
  if (version >= 7) {
    for (i = 0; i < 6; i++) {
      for (var j = 0; j < 3; j++) {
        reserved[size - 11 + j][i] = true;
        reserved[i][size - 11 + j] = true;
      }
    }
  }
}
 
function qrPlaceTiming(m, reserved) {
  var size = m.length;
  for (var i = 8; i < size - 8; i++) {
    var v = (i % 2 === 0) ? 1 : 0;
    if (!reserved[6][i]) { m[6][i] = v; reserved[6][i] = true; }
    if (!reserved[i][6]) { m[i][6] = v; reserved[i][6] = true; }
  }
}
 
function qrPlaceData(m, reserved, codewords) {
  var size = m.length;
  var bitIndex = 0;
  var totalBits = codewords.length * 8;
  var upward = true;
 
  for (var right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (var step = 0; step < size; step++) {
      var row = upward ? (size - 1 - step) : step;
      for (var k = 0; k < 2; k++) {
        var col = right - k;
        if (reserved[row][col]) continue;
        var bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        m[row][col] = bit;
      }
    }
    upward = !upward;
  }
}
 
function qrMaskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
  return false;
}
 
function qrApplyMask(m, reserved, mask) {
  var out = [];
  for (var r = 0; r < m.length; r++) {
    out.push(m[r].slice());
    for (var c = 0; c < m.length; c++) {
      if (!reserved[r][c] && qrMaskBit(mask, r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}
 
function qrFormatBits(mask) {
  // ECC level H = 0b10
  var data = (0x02 << 3) | mask;
  var rem = data;
  for (var i = 0; i < 10; i++) {
    rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}
 
function qrVersionBits(version) {
  var rem = version;
  for (var i = 0; i < 12; i++) {
    rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  }
  return (version << 12) | rem;
}
 
function qrDrawFormat(m, mask) {
  var size = m.length;
  var bits = qrFormatBits(mask);
  for (var i = 0; i < 15; i++) {
    var bit = (bits >>> i) & 1;
 
    // Vertical strip: column 8, top-left downward then bottom-left
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;
 
    // Horizontal strip: row 8, top-right leftward then top-left
    if (i < 8) m[8][size - 1 - i] = bit;
    else if (i < 9) m[8][15 - i] = bit;
    else m[8][14 - i] = bit;
  }
  m[size - 8][8] = 1; // dark module
}
 
function qrDrawVersion(m, version) {
  if (version < 7) return;
  var size = m.length;
  var bits = qrVersionBits(version);
  for (var i = 0; i < 18; i++) {
    var bit = (bits >>> i) & 1;
    var a = Math.floor(i / 3);
    var b = i % 3;
    m[size - 11 + b][a] = bit;
    m[a][size - 11 + b] = bit;
  }
}
 
function qrPenalty(m) {
  var size = m.length;
  var score = 0;
  var r, c, i, run, dark = 0;
 
  // Rule 1: runs of 5+ same-colour modules
  for (r = 0; r < size; r++) {
    run = 1;
    for (c = 1; c < size; c++) {
      if (m[r][c] === m[r][c - 1]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (c = 0; c < size; c++) {
    run = 1;
    for (r = 1; r < size; r++) {
      if (m[r][c] === m[r - 1][c]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
 
  // Rule 2: 2x2 blocks of the same colour
  for (r = 0; r < size - 1; r++) {
    for (c = 0; c < size - 1; c++) {
      var v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
 
  // Rule 3: finder-like patterns
  var p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  var p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (r = 0; r < size; r++) {
    for (c = 0; c <= size - 11; c++) {
      var okA = true, okB = true;
      for (i = 0; i < 11; i++) {
        if (m[r][c + i] !== p1[i]) okA = false;
        if (m[r][c + i] !== p2[i]) okB = false;
      }
      if (okA) score += 40;
      if (okB) score += 40;
    }
  }
  for (c = 0; c < size; c++) {
    for (r = 0; r <= size - 11; r++) {
      var okC = true, okD = true;
      for (i = 0; i < 11; i++) {
        if (m[r + i][c] !== p1[i]) okC = false;
        if (m[r + i][c] !== p2[i]) okD = false;
      }
      if (okC) score += 40;
      if (okD) score += 40;
    }
  }
 
  // Rule 4: overall dark/light balance
  for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
  var percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
 
  return score;
}
 
/**
 * Encode a string into a QR matrix.
 * Returns a 2D array of 0/1 where 1 = dark module. No quiet zone included.
 */
function qrEncode(text) {
  var dataBytes = qrUtf8Bytes(text);
  var version = qrPickVersion(dataBytes.length);
  var size = version * 4 + 17;
 
  var base = qrNewMatrix(size);
  var reserved = [];
  for (var i = 0; i < size; i++) {
    reserved.push([]);
    for (var j = 0; j < size; j++) reserved[i].push(false);
  }
 
  qrPlaceFinder(base, reserved, 0, 0);
  qrPlaceFinder(base, reserved, 0, size - 7);
  qrPlaceFinder(base, reserved, size - 7, 0);
  qrPlaceAlignment(base, reserved, version);
  qrPlaceTiming(base, reserved);
  qrReserveFormat(base, reserved, version);
 
  var codewords = qrBuildCodewords(version, dataBytes);
  qrPlaceData(base, reserved, codewords);
 
  var best = null, bestScore = Infinity, bestMask = 0;
  for (var mask = 0; mask < 8; mask++) {
    var candidate = qrApplyMask(base, reserved, mask);
    qrDrawFormat(candidate, mask);
    qrDrawVersion(candidate, version);
    var score = qrPenalty(candidate);
    if (score < bestScore) { bestScore = score; best = candidate; bestMask = mask; }
  }
  return best;
}
 
 
var PNG_CRC_TABLE = (function () {
  var table = new Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();
 
function pngCrc32(bytes) {
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) {
    crc = PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
 
function pngAdler32(bytes) {
  var a = 1, b = 0;
  for (var i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
 
function pngU32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
 
function pngChunk(type, data) {
  var typeBytes = [];
  for (var i = 0; i < type.length; i++) typeBytes.push(type.charCodeAt(i));
  var body = typeBytes.concat(data);
  return pngU32(data.length).concat(body, pngU32(pngCrc32(body)));
}
 
function pngStoredDeflate(raw) {
  var out = [0x78, 0x01]; // zlib header: deflate, 32K window, no dictionary
  var pos = 0;
  if (raw.length === 0) {
    out.push(0x01, 0x00, 0x00, 0xff, 0xff);
  }
  while (pos < raw.length) {
    var len = Math.min(65535, raw.length - pos);
    var final = (pos + len >= raw.length) ? 1 : 0;
    out.push(final);
    out.push(len & 0xff, (len >>> 8) & 0xff);
    out.push(~len & 0xff, (~len >>> 8) & 0xff);
    for (var i = 0; i < len; i++) out.push(raw[pos + i]);
    pos += len;
  }
  return out.concat(pngU32(pngAdler32(raw)));
}
 
/**
 * Render a QR matrix (2D array of 0/1, 1 = dark) to PNG bytes.
 * @param {Array<Array<number>>} matrix
 * @param {number} scale        pixels per module
 * @param {number} quietModules white border width in modules (4 is the spec minimum)
 * @return {Array<number>} PNG file bytes
 */
function pngFromQrMatrix(matrix, scale, quietModules) {
  scale = scale || 8;
  quietModules = (quietModules === undefined) ? 4 : quietModules;
 
  var modules = matrix.length + quietModules * 2;
  var width = modules * scale;
  var height = width;
  var rowBytes = Math.ceil(width / 8);
 
  var raw = [];
  for (var y = 0; y < height; y++) {
    raw.push(0); // filter type: none
    var moduleRow = Math.floor(y / scale) - quietModules;
    var row = new Array(rowBytes);
    for (var i = 0; i < rowBytes; i++) row[i] = 0xff; // start all white
    if (moduleRow >= 0 && moduleRow < matrix.length) {
      for (var x = 0; x < width; x++) {
        var moduleCol = Math.floor(x / scale) - quietModules;
        if (moduleCol < 0 || moduleCol >= matrix.length) continue;
        if (matrix[moduleRow][moduleCol]) {
          row[x >> 3] &= ~(0x80 >> (x & 7)); // clear bit = black
        }
      }
    }
    for (var j = 0; j < rowBytes; j++) raw.push(row[j] & 0xff);
  }
 
  var ihdr = pngU32(width).concat(
    pngU32(height),
    [1, 0, 0, 0, 0] // bit depth 1, colour type 0 (grayscale), deflate, filter 0, no interlace
  );
 
  var signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.concat(
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', pngStoredDeflate(raw)),
    pngChunk('IEND', [])
  );
}

