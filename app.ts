// The HTTP server: one process serving the git smart-HTTP surface, REST v3, GraphQL and MCP.
// Routing is by path shape; every route past /healthz requires the trial's bearer token, and every
// failure — including a crash inside a handler — is answered as JSON, never an HTML error page.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getRepo } from './store.ts';
import { handleGitRoute } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { ApiError, authOk, readBody, sendJson } from './util.ts';

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const path = url.pathname;

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (!authOk(req)) throw new ApiError(401, 'Unauthorized');

  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const repo = getRepo(owner, name);
    if (repo === undefined) throw new ApiError(404, 'Not Found');
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleGitRoute(req, res, repo, gitMatch[3] as string, url.searchParams, body);
    return;
  }

  if (path === '/api/graphql') {
    const body = await readBody(req);
    await handleGraphql(req, res, body);
    return;
  }
  if (path === '/mcp') {
    const body = await readBody(req);
    await handleMcp(req, res, body);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const rest = path.slice('/api/v3'.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/');
    const body = req.method === 'GET' || req.method === 'DELETE' && segments.length === 3 ? Buffer.alloc(0) : await readBody(req);
    handleRest(req, res, segments, url.searchParams, body);
    return;
  }
  throw new ApiError(404, 'Not Found');
}

/** Create the forge's HTTP server (not yet listening). */
export function createApp(): Server {
  return createServer((req, res) => {
    dispatch(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ApiError) {
        sendJson(res, err.status, { message: err.message });
      } else {
        console.error('forge: unhandled error', err);
        sendJson(res, 500, { message: 'Internal error' });
      }
    });
  });
}
