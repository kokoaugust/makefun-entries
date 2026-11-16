// The git smart-HTTP surface, implemented from the protocol up: pkt-line framing, pack reading
// and writing over node:zlib, ref advertisement (protocol v2 and the v0 fallback), fetch with
// want/have negotiation and shallow support, and receive-pack with fast-forward-only enforcement
// and per-ref report-status. No git binary is involved anywhere — objects live in the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID, commitClosure, getObject, hashObject, isOid, objects, parseCommit, parseTree, putObject, treeClosure,
  type GitObj, type ObjType, type RepoRec,
} from './store.ts';
import { ApiError, sendRaw } from './util.ts';

// ---------------------------------------------------------------- pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');

/** Frame one payload as a pkt-line (4 hex digits of total length + payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export interface PktReader {
  /** The next packet's payload, or null at a flush packet / end of input. */
  next(): Buffer | null;
  /** The unconsumed remainder (a receive-pack's packfile starts here). */
  rest(): Buffer;
  /** Whether the last packet read was a delimiter (0001) rather than a flush. */
  lastWasDelim(): boolean;
}

/** A cursor over a pkt-line stream. */
export function pktReader(buffer: Buffer): PktReader {
  let offset = 0;
  let delim = false;
  return {
    next(): Buffer | null {
      delim = false;
      if (offset + 4 > buffer.length) return null;
      const header = buffer.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-f]{4}$/.test(header)) return null;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        return null;
      }
      if (length === 1) {
        delim = true;
        offset += 4;
        return null;
      }
      if (length < 4 || offset + length > buffer.length) return null;
      const payload = buffer.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    rest(): Buffer {
      return buffer.subarray(offset);
    },
    lastWasDelim(): boolean {
      return delim;
    },
  };
}

/** Split a packet payload into lines, trimming trailing newlines. */
export function pktLines(reader: PktReader): string[] {
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    lines.push(packet.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- packs

const OBJ_TYPES: readonly ObjType[] = ['commit', 'tree', 'blob', 'tag'];
const TYPE_NUMBERS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate one zlib stream starting at `offset`; answers the data and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // With {info: true} Node answers a {buffer, engine} pair; engine.bytesWritten is the number of
  // compressed bytes consumed, which is how a pack's next entry is located.
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: Buffer.from(result.buffer), next: offset + result.engine.bytesWritten };
}

/**
 * Read a pack into the store, resolving OFS/REF deltas against the pack itself and, for a thin
 * pack, against objects the store already holds. Answers the ids the pack delivered.
 */
export function readPack(pack: Buffer): string[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new ApiError(400, 'Not a packfile');
  }
  const count = pack.readUInt32BE(8);
  interface RawEntry { type: number; size: number; data?: Buffer; ofsBase?: number; refBase?: string; start: number }
  const entries: RawEntry[] = [];
  const byStart = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { type, size, start };
    if (type === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      entry.ofsBase = start - baseOffset;
    } else if (type === 7) {
      entry.refBase = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    entry.data = inflated.data;
    offset = inflated.next;
    entries.push(entry);
    byStart.set(start, entries.length - 1);
  }
  // Resolve entries to plain objects (deltas apply recursively).
  const resolved = new Map<number, { type: ObjType; data: Buffer }>();
  const resolve = (index: number): { type: ObjType; data: Buffer } => {
    const memo = resolved.get(index);
    if (memo !== undefined) return memo;
    const entry = entries[index] as RawEntry;
    let out: { type: ObjType; data: Buffer };
    if (entry.type >= 1 && entry.type <= 4) {
      out = { type: OBJ_TYPES[entry.type - 1] as ObjType, data: entry.data as Buffer };
    } else {
      let base: { type: ObjType; data: Buffer };
      if (entry.type === 6) {
        base = resolve(byStart.get(entry.ofsBase as number) as number);
      } else {
        const baseOid = entry.refBase as string;
        const existing = getObject(baseOid);
        if (existing !== undefined) base = existing;
        else {
          const baseIndex = entries.findIndex(
            (candidate, candidateIndex) => candidate.type >= 1 && candidate.type <= 4
              && hashObject(resolve(candidateIndex).type, resolve(candidateIndex).data) === baseOid,
          );
          if (baseIndex < 0) throw new ApiError(400, 'Pack delta base is missing');
          base = resolve(baseIndex);
        }
      }
      out = { type: base.type, data: applyDelta(base.data, entry.data as Buffer) };
    }
    resolved.set(index, out);
    return out;
  };
  const delivered: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const obj = resolve(i);
    delivered.push(putObject(obj.type, obj.data));
  }
  return delivered;
}

/** Apply a git delta buffer to its base. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOffset |= (delta[offset] as number) << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= (delta[offset] as number) << (8 * i); offset += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOffset, cpOffset + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new ApiError(400, 'Delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) throw new ApiError(400, 'Delta size mismatch');
  return result;
}

/** Write a pack (version 2, plain objects) with its SHA-1 trailer. */
export function writePack(objectsToSend: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objectsToSend.length, 8);
  parts.push(header);
  for (const obj of objectsToSend) {
    const typeNumber = TYPE_NUMBERS[obj.type];
    const size = obj.data.length;
    const head: number[] = [];
    let first = (typeNumber << 4) | (size & 15);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    head.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- refs and advertisement

/** Peel a (possibly annotated) tag to the commit it names; anything else peels to itself. */
export function peel(oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const obj = getObject(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

/** Every ref the repo advertises: HEAD first (as a symref), then refs sorted by name. */
function refLines(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  else lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headRef, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const peeled = peel(oid);
    lines.push({ oid, name, peeled: peeled !== oid ? peeled : undefined });
  }
  return lines;
}

const AGENT = 'agent=forge/1.0';
const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

/** The `# service=…` preamble plus a flush, opening every smart-HTTP advertisement. */
function servicePreamble(service: string): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH]);
}

/** GET …/info/refs?service=… — v2 advertisement when asked, the v0 ref list otherwise. */
export function handleInfoRefs(res: ServerResponse, repo: RepoRec, service: string, protocolHeader: string): void {
  const isUpload = service === 'git-upload-pack';
  const type = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const parts: Buffer[] = [servicePreamble(service)];
  if (isUpload && protocolHeader.includes('version=2')) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('server-option\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), type);
    return;
  }
  const lines = refLines(repo);
  if (repo.refs.size === 0) {
    const caps = isUpload ? `${UPLOAD_CAPS_V0} ${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}` : `${RECEIVE_CAPS} ${AGENT}`;
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      let text: string;
      if (line.name === 'HEAD' && line.unborn !== true) {
        text = `${line.oid} HEAD`;
      } else if (line.name === 'HEAD') {
        text = `${ZERO_OID} HEAD`;
      } else {
        text = `${line.oid} ${line.name}`;
      }
      if (index === 0) {
        const caps = isUpload
          ? `${UPLOAD_CAPS_V0} ${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
          : `${RECEIVE_CAPS} ${AGENT}`;
        text += `\0${caps}`;
      }
      parts.push(pktLine(`${text}\n`));
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), type);
}

/** Answer a v2 ls-refs request from its argument lines. */
function answerLsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'peel') wantPeel = true;
    else if (arg === 'symrefs') wantSymrefs = true;
    else if (arg === 'unborn') wantUnborn = true;
  }
  const parts: Buffer[] = [];
  for (const line of refLines(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
    if (line.unborn === true) {
      if (!wantUnborn) continue;
      parts.push(pktLine(`unborn ${line.name} symref-target:${line.symrefTarget as string}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (wantSymrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (wantPeel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

/** The objects a fetch must deliver, and the shallow boundary afterwards. */
function computeFetch(req: FetchRequest): { send: Set<string>; shallow: string[]; unshallow: string[] } {
  const send = new Set<string>();
  const shallowOut = new Set<string>();
  const unshallowOut = new Set<string>();
  const excluded = new Set<string>();
  const shallowSet = new Set(req.shallow);
  for (const have of req.haves) {
    // A shallow have is a lie of depth: the client holds only the boundary commit and its trees,
    // not its ancestry — excluding the whole closure would starve a deepen fetch.
    if (shallowSet.has(have)) continue;
    for (const oid of commitClosure(have)) excluded.add(oid);
  }
  // The client's already-shallow commits and their trees are already held.
  for (const shallowOid of req.shallow) {
    const obj = getObject(shallowOid);
    if (obj !== undefined && obj.type === 'commit') {
      excluded.add(shallowOid);
      for (const oid of treeClosure(parseCommit(obj.data).tree)) excluded.add(oid);
    }
  }
  const depth = req.deepen;
  if (depth === null) {
    for (const want of req.wants) {
      if (getObject(want)?.type === 'tag') send.add(want);
      for (const oid of commitClosure(peel(want))) {
        if (!excluded.has(oid)) send.add(oid);
      }
    }
    for (const oid of [...send]) if (excluded.has(oid)) send.delete(oid);
    return { send, shallow: [], unshallow: [] };
  }
  // Depth-limited: walk each want's first-parent-ish ancestry breadth-first, level by level.
  const included = new Set<string>();
  let frontier = req.wants.map((want) => peel(want)).filter((oid) => getObject(oid)?.type === 'commit');
  for (const want of req.wants) if (getObject(want)?.type === 'tag') send.add(want);
  const boundary = new Set<string>();
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      if (excluded.has(oid)) continue;
      included.add(oid);
      const view = parseCommit((getObject(oid) as GitObj).data);
      if (level === depth - 1) boundary.add(oid);
      else next.push(...view.parents);
    }
    frontier = next;
  }
  // A deepen from an existing shallow clone: the old boundary deepens too, so the commits just
  // past the included set join the pack and the boundary moves down to them.
  if (depth > 1 && req.shallow.length > 0) {
    const extra: string[] = [];
    for (const shallowOid of req.shallow) {
      const obj = getObject(shallowOid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!included.has(parent) && !excluded.has(parent) && getObject(parent)?.type === 'commit') {
          extra.push(parent);
        }
      }
      if (extra.length > 0) unshallowOut.add(shallowOid);
    }
    for (const oid of extra) {
      included.add(oid);
      boundary.add(oid);
    }
  }
  for (const oid of included) {
    send.add(oid);
    const view = parseCommit((getObject(oid) as GitObj).data);
    for (const treeOid of treeClosure(view.tree)) send.add(treeOid);
  }
  for (const oid of [...send]) if (excluded.has(oid) && !included.has(oid)) send.delete(oid);
  for (const oid of boundary) {
    const obj = getObject(oid);
    if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallowOut.add(oid);
  }
  return { send, shallow: [...shallowOut], unshallow: [...unshallowOut] };
}

/** Wrap a packfile in sideband packets (band 1 = data), 32 KiB per packet. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function objectsForSend(send: ReadonlySet<string>): GitObj[] {
  const out: GitObj[] = [];
  for (const oid of send) {
    const obj = getObject(oid);
    if (obj !== undefined) out.push(obj);
  }
  return out;
}

/** POST …/git-upload-pack — v2 (command=fetch / ls-refs) and the v0 want/have dialogue. */
export function handleUploadPack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const reader = pktReader(body);
  const first = reader.next();
  if (first === null) throw new ApiError(400, 'Empty upload-pack request');
  const firstLine = first.toString('utf8').replace(/\n$/, '');
  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length).trim();
    // Capability lines run to the delimiter packet; argument lines to the flush.
    pktLines(reader);
    if (reader.lastWasDelim()) {
      // arguments follow
    }
    if (command === 'ls-refs') {
      const args = pktLines(reader);
      sendRaw(res, 200, answerLsRefs(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const args = pktLines(reader);
      const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) req.deepen = Number.parseInt(arg.slice(7).trim(), 10);
        else if (arg === 'done') req.done = true;
      }
      const { send, shallow, unshallow } = computeFetch(req);
      const parts: Buffer[] = [];
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine(req.haves.length > 0 ? `ACK ${req.haves[0] as string}\n` : 'NAK\n'));
      parts.push(FLUSH);
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(FLUSH);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPack(writePack(objectsForSend(send))));
      parts.push(FLUSH);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    throw new ApiError(400, `Unknown protocol v2 command: ${command}`);
  }
  // Protocol v0: want lines to a flush, then have lines to a flush.
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  const readWant = (line: string): void => {
    if (line.startsWith('want ')) req.wants.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) req.deepen = Number.parseInt(line.slice(7).trim(), 10);
  };
  readWant(firstLine);
  for (const line of pktLines(reader)) readWant(line);
  for (const line of pktLines(reader)) {
    if (line.startsWith('have ')) req.haves.push(line.slice(5, 45));
    else if (line === 'done') req.done = true;
  }
  const { send, shallow, unshallow } = computeFetch(req);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(writePack(objectsForSend(send))));
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- receive-pack

/** Whether moving `ref` from `oldOid` to `newOid` is a fast-forward (or a create/delete). */
function fastForwardOk(repo: RepoRec, ref: string, oldOid: string, newOid: string): boolean {
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return false;
  if (newOid === ZERO_OID) return true; // a delete
  if (oldOid === ZERO_OID) return true; // a create
  if (getObject(newOid)?.type === 'tag') return true; // tags may point anywhere
  return isAncestorLocal(oldOid, newOid);
}

function isAncestorLocal(ancestor: string, tip: string): boolean {
  const stack = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** POST …/git-receive-pack — apply a push and answer the sideband report-status. */
export function handleReceivePack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const reader = pktReader(body);
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    let line = packet.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
  }
  const rest = reader.rest();
  let unpackLine = 'unpack ok\n';
  const isDeleteOnly = commands.every((c) => c.newOid === ZERO_OID);
  if (!isDeleteOnly && rest.length > 0) {
    try {
      readPack(rest);
    } catch {
      unpackLine = 'unpack pack-objects failed\n';
    }
  }
  const report: string[] = [unpackLine];
  if (unpackLine === 'unpack ok\n') {
    for (const command of commands) {
      if (fastForwardOk(repo, command.ref, command.oldOid, command.newOid)) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      } else {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      }
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  }
  const payload = Buffer.concat([...report.map((line) => pktLine(line)), FLUSH]);
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const chunk = payload.subarray(offset, Math.min(offset + CHUNK, payload.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** The git route table: info/refs, upload-pack, receive-pack under /{owner}/{repo}.git/. */
export function handleGitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  tail: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  if (tail === 'info/refs' && req.method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      throw new ApiError(400, 'Missing or unknown service');
    }
    handleInfoRefs(res, repo, service, typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : '');
    return;
  }
  if (tail === 'git-upload-pack' && req.method === 'POST') {
    handleUploadPack(res, repo, body);
    return;
  }
  if (tail === 'git-receive-pack' && req.method === 'POST') {
    handleReceivePack(res, repo, body);
    return;
  }
  throw new ApiError(404, 'Not Found');
}



