// "The Smallest Hero" — entry program for ai-excited-01.
//
// The artwork (entry.png, sitting next to this file) shows a tiny caped
// mouse riding a breaching blue whale up toward the full moon. This
// program is the delivery mechanism: it inspects the image, refuses to
// ship anything that breaks the competition gate (at most 1 MiB, at most
// 1024 px on either side, PNG or JPEG only), and then places a copy in
// the output directory under the required name.
//
// Local check:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BYTE_LIMIT = 1_048_576; // one mebibyte, the gate's size ceiling
const SIDE_LIMIT = 1024;      // the gate's per-dimension ceiling

const ownDir = dirname(fileURLToPath(import.meta.url));
const imagePath = join(ownDir, 'entry.png');

// --- dimension readers -------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(buf: Buffer): boolean {
  return PNG_MAGIC.every((b, idx) => buf[idx] === b);
}

// PNG stores width and height as big-endian uint32s inside the IHDR
// chunk, which always starts right after the 8-byte signature.
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) throw new Error('PNG header is truncated');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// JPEG is a chain of marker segments. Walk the chain until a
// start-of-frame segment turns up; it carries height then width as
// big-endian uint16s after its length and precision fields.
function jpegSize(buf: Buffer): { width: number; height: number } {
  let pos = 2; // skip the SOI marker (FF D8)
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) throw new Error(`JPEG segment out of sync at byte ${pos}`);
    const marker = buf[pos + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    const segLen = buf.readUInt16BE(pos + 2);
    if (segLen < 2) throw new Error('JPEG segment has an impossible length');
    pos += 2 + segLen;
  }
  throw new Error('no start-of-frame segment found in JPEG');
}

type ImageInfo = { format: 'png' | 'jpeg'; width: number; height: number };

function inspect(buf: Buffer): ImageInfo {
  if (looksLikePng(buf)) return { format: 'png', ...pngSize(buf) };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { format: 'jpeg', ...jpegSize(buf) };
  throw new Error('entry.png is neither a PNG nor a JPEG image');
}

function checkAgainstGate(buf: Buffer): ImageInfo {
  if (buf.length > BYTE_LIMIT) {
    throw new Error(`entry.png weighs ${buf.length} bytes; the gate allows ${BYTE_LIMIT}`);
  }
  const info = inspect(buf);
  if (info.width > SIDE_LIMIT || info.height > SIDE_LIMIT) {
    throw new Error(`entry.png measures ${info.width}x${info.height}; the gate allows ${SIDE_LIMIT} per side`);
  }
  return info;
}

// --- main flow ---------------------------------------------------------

const imageBytes = readFileSync(imagePath);
const info = checkAgainstGate(imageBytes);

const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(targetDir, { recursive: true });

const targetPath = join(targetDir, 'entry.png');
copyFileSync(imagePath, targetPath);

console.log(
  `The Smallest Hero delivered: ${targetPath} ` +
  `(${info.format}, ${info.width}x${info.height}, ${imageBytes.length} bytes)`,
);

