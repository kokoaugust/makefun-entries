// The trial lifecycle, per the wire contract: read the env URL, start the forge on an ephemeral
// port, register that port with the env (the first registration wins; a 409 means another entry
// owns the trial, so keep waiting), then poll the env's /done until it answers done and exit 0.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One request to the env service with a hard timeout; undefined on a network failure. */
async function envRequest(envUrl: string, path: string, init: RequestInit): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${envUrl}${path}`, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('forge: no port was assigned');
    process.exit(1);
  }
  const port = address.port;

  // Register until the env accepts. 200 = accepted; 409 = another entry registered first (keep
  // waiting for /done); 400/405 = a contract error — exit at once rather than retry forever.
  for (let attempt = 0; ; attempt += 1) {
    const response = await envRequest(envUrl, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (response !== undefined && response.status === 200) break;
    if (response !== undefined && response.status === 409) break;
    if (response !== undefined && (response.status === 400 || response.status === 405)) {
      console.error(`forge: registration refused with ${response.status}`);
      process.exit(1);
    }
    await sleep(Math.min(250 * 2 ** attempt, 2000));
  }

  // Poll /done: the env answers {"done": false} until its export is written, then true. The poll
  // interval is short (the trial's wall budget is spent grading, not waiting) and a failed poll
  // simply retries — the env, not this process, decides when the trial is over.
  for (;;) {
    const response = await envRequest(envUrl, '/done', { method: 'GET' });
    if (response !== undefined && response.ok) {
      try {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) break;
      } catch {
        // A malformed answer is treated as "not done"; keep polling.
      }
    }
    await sleep(250);
  }

  server.close(() => process.exit(0));
  // Never hang the trial on a lingering connection.
  setTimeout(() => process.exit(0), 2000).unref();
}

await main();
