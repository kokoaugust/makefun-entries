// The MCP surface at /mcp: JSON-RPC 2.0 over Streamable HTTP. The client probes server/discover
// first, so the forge answers it with the 2026-07-28 revision; initialize is answered too, for
// clients that start there. The six tools act on the same store as REST — a repository or issue
// created here is the same record REST reads back — and tools/list is one frozen constant, so two
// calls answer byte-for-byte identical lists.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  branchTip, createRepo, freshIssueId, getRepo, squashMerge, isoNow,
  type IssueRec, type PullRec, type RepoRec,
} from './store.ts';
import { ApiError, sendJson, stringField } from './util.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const PROTOCOL_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = [PROTOCOL_REVISION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const INTEGER = { type: 'integer' };

function needRepoByArgs(args: Record<string, unknown>): RepoRec {
  const owner = stringField(args, 'owner') || VIEWER.login;
  const repoName = stringField(args, 'repo') || stringField(args, 'repository');
  const repo = getRepo(owner, repoName);
  if (repo === undefined) throw new ToolError(`Repository ${owner}/${repoName} not found`);
  return repo;
}

class ToolError extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema({ name: STRING, description: STRING, private: BOOLEAN }, ['name']),
    run: (args) => {
      const name = stringField(args, 'name');
      if (name === '') throw new ToolError('name is required');
      const existing = getRepo(VIEWER.login, name);
      if (existing !== undefined) return repoJson(existing);
      const repo = createRepo(name, args.private === true, stringField(args, 'description'));
      if (repo === null) throw new ToolError('name already exists');
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
    run: (args) => repoJson(needRepoByArgs(args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
    run: (args) => {
      const repo = needRepoByArgs(args);
      const title = stringField(args, 'title');
      if (title === '') throw new ToolError('title is required');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = { number, id: freshIssueId(), title, body: stringField(args, 'body'), state: 'open', labels: [], comments: [] };
      repo.issues.set(number, issue);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
    run: (args) => {
      const repo = needRepoByArgs(args);
      const state = stringField(args, 'state');
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return { issues: issues.map((issue) => issueJson(repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, head: STRING, base: STRING, body: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
    run: (args) => {
      const repo = needRepoByArgs(args);
      const head = stringField(args, 'head');
      const base = stringField(args, 'base');
      if (branchTip(repo, head) === undefined) throw new ToolError(`Head branch "${head}" does not exist`);
      if (branchTip(repo, base) === undefined) throw new ToolError(`Base branch "${base}" does not exist`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number, id: freshIssueId(), title: stringField(args, 'title'), body: stringField(args, 'body'),
        head, base, state: 'open', merged: false, mergeCommitSha: null, mergedAt: null,
      };
      repo.pulls.set(number, pull);
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) onto its base branch.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, pull_number: INTEGER }, ['owner', 'repo', 'pull_number']),
    run: (args) => {
      const repo = needRepoByArgs(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolError(`Pull request ${number} not found`);
      if (!pull.merged) {
        const sha = squashMerge(repo, pull);
        if (sha === null) throw new ToolError('Pull request is not mergeable');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeCommitSha = sha;
        pull.mergedAt = isoNow();
      }
      return pullJson(repo, pull);
    },
  },
];

/** The frozen tools/list payload — identical bytes on every call. */
const TOOLS_LIST = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

/** Normalize a tool name for matching: lowercase, alphanumerics only (prefixes tolerated). */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeToolName(name);
  return TOOLS.find((tool) => {
    const candidate = normalizeToolName(tool.name);
    return wanted === candidate || wanted.endsWith(candidate);
  });
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id as string | number | null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id as string | number | null, error };
}

/** Handle one JSON-RPC request object; answers the response object (or null for notifications). */
function handleRpc(request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_REVISION;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_REVISIONS.includes(requested) ? requested : PROTOCOL_REVISION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = findTool(name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const schema = tool.inputSchema as { required?: string[] };
      const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === '');
      if (missing.length > 0) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        });
      }
      try {
        const value = tool.run(args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        if (err instanceof ToolError) {
          return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        throw err;
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** POST /mcp — one JSON-RPC request (batches answered per element). Auth is enforced upstream. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  void req;
  const text = rawBody.toString('utf8').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON body is the contract's parse error: HTTP 400 with -32700.
    sendJson(res, 400, rpcError(extractId(text), -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed
      .map((entry) => handleRpc((entry ?? {}) as Record<string, unknown>))
      .filter((entry) => entry !== null);
    sendJson(res, 200, results);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const response = handleRpc(parsed as Record<string, unknown>);
  if (response === null) {
    sendJson(res, 200, {});
    return;
  }
  sendJson(res, 200, response);
}

/** Best-effort id recovery from a malformed body (the parse-error check names its id). */
function extractId(text: string): unknown {
  const match = /"id"\s*:\s*(\d+|"[^"]*")/.exec(text);
  if (match === null) return null;
  const raw = match[1] as string;
  return raw.startsWith('"') ? raw.slice(1, -1) : Number.parseInt(raw, 10);
}

