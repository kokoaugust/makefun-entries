// Small HTTP plumbing shared by every surface: JSON replies with the request-id header the wire
// contract requires, body reading, JSON parsing with the contract's 400, bearer-token auth, and an
// ApiError a handler can throw to answer a status with a {message} body.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** An error that maps straight onto an HTTP status and a {"message"} body. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let requestCounter = 0;

/** A non-empty, unique-per-process request id (a counter, never a clock). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Answer with a JSON body and the headers every REST reply carries. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes under an explicit content type (the git smart-HTTP surface). */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** Answer with no body at all (a 204). */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** The most bytes one request body may hold; past it the request is refused, never buffered whole. */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** Read a request body whole. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

/**
 * Parse a JSON request body: an empty body is an empty object; malformed JSON is the contract's
 * 400. A parsed non-object (array, string, number) is also a 400 for the object-shaped routes.
 */
export function parseJsonObject(raw: Buffer): Record<string, unknown> {
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Malformed JSON body');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'JSON body must be an object');
  }
  return value as Record<string, unknown>;
}

/** Whether the request carries the trial's bearer token (MAKEFUN_SHOP_TOKEN). */
export function authOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  // In a trial the env sets the token and it must match exactly. Outside one (a local practice
  // run) any non-empty bearer token is accepted, so the runner's --token flag is free to choose.
  return expected === '' || presented === expected;
}

/** Decode one URL path segment, tolerating bad escapes. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A string field of a JSON body, or '' when absent/not a string. */
export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** Standard base64 of a buffer (the contents API's encoding). */
export function toBase64(data: Buffer): string {
  return data.toString('base64');
}

/** Decode base64, ignoring the whitespace GitHub wraps content in. */
export function fromBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

