// ai-excited-01 entry: "The Smallest Hero" — a caped mouse riding a breaching
// blue whale toward the full moon. The program validates the image against the
// gate's limits, then copies it to the output directory as entry.png.
//
// Run locally:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1048576; // 1 MiB gate limit
const MAX_SIDE = 1024;     // gate limit per side

const src = new URL('./entry.png', import.meta.url);
const bytes = readFileSync(src);

if (bytes.length > MAX_BYTES) {
  throw new Error(`entry image is ${bytes.length} bytes, over the ${MAX_BYTES} gate limit`);
}

// Tell PNG from JPEG by the first bytes, as the gate does, and read the size.
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) { // PNG
    return { kind: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: walk segments to the SOF marker
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { kind: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error('entry image is neither PNG nor JPEG');
}

const info = imageSize(bytes);
if (info.width > MAX_SIDE || info.height > MAX_SIDE) {
  throw new Error(`entry image is ${info.width}x${info.height}, over the ${MAX_SIDE} gate limit`);
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, 'entry.png');
writeFileSync(dest, bytes);
console.log(`wrote ${dest}: ${info.kind} ${info.width}x${info.height}, ${bytes.length} bytes`);

