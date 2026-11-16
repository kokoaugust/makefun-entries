// The REST v3 surface: repositories, contents backed by real git commits, labels, issues, pull
// requests and the squash merge. Every handler answers JSON; failures are ApiErrors carrying the
// status and message the wire contract names.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  branchTip, commitOnBranch, createRepo, deleteRepo, diffCommits, filesAtCommit, freshCommentId, freshIssueId,
  getRepo, isoNow, listCommits, mergeBase, objects, parseCommit, putObject, repoKey, repos, squashMerge, threeWayMerge, viewerRepos,
  type IssueRec, type PullRec, type RepoRec,
} from './store.ts';
import { ApiError, decodeSegment, fromBase64, parseJsonObject, sendEmpty, sendJson, stringField, toBase64 } from './util.ts';

const SCOPES = 'repo, read:org';
export const FORGE_VERSION = '1.0.0';

// ---------------------------------------------------------------- serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: `R_${repo.dbId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  void repo;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: branchTip(repo, pull.head) ?? null, repo: { full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: pull.base, sha: branchTip(repo, pull.base) ?? null, repo: { full_name: `${repo.owner}/${repo.name}` } },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: isoNow(), updated_at: isoNow() };
}

// ---------------------------------------------------------------- helpers

function needRepo(owner: string, name: string): RepoRec {
  const repo = getRepo(owner, name);
  if (repo === undefined) throw new ApiError(404, 'Not Found');
  return repo;
}

/** Resolve a ref-ish value (branch name, ref, or commit id) to a commit id. */
export function resolveRef(repo: RepoRec, value: string): string | undefined {
  if (value === 'HEAD') return branchTip(repo, repo.defaultBranch);
  const byRef = repo.refs.get(value);
  if (byRef !== undefined) return derefTag(byRef);
  const byBranch = branchTip(repo, value);
  if (byBranch !== undefined) return derefTag(byBranch);
  const obj = objects.get(value);
  if (obj !== undefined && obj.type === 'commit') return value;
  if (obj !== undefined && obj.type === 'tag') return derefTag(value);
  return undefined;
}

/** Follow an annotated tag to its commit; anything else answers itself. */
export function derefTag(oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

/** The request's own origin, for absolute pagination links. */
function originOf(req: IncomingMessage): string {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : '127.0.0.1';
  return `http://${host}`;
}

// ---------------------------------------------------------------- repositories

function handleCreateRepo(res: ServerResponse, body: Record<string, unknown>): void {
  const name = stringField(body, 'name');
  if (name === '') throw new ApiError(422, 'name is required');
  const isPrivate = body.private === true;
  const description = stringField(body, 'description');
  const existing = getRepo(VIEWER.login, name);
  if (existing !== undefined) throw new ApiError(422, 'name already exists on this account');
  const repo = createRepo(name, isPrivate, description);
  if (repo === null) throw new ApiError(422, 'name already exists on this account');
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  sendJson(res, 201, repoJson(repo));
}

function handleListUserRepos(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const all = viewerRepos();
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    headers.link = `<${originOf(req)}/api/v3/user/repos?${next.toString()}>; rel="next"`;
  }
  sendJson(res, 200, slice.map(repoJson), headers);
}

function handlePatchRepo(res: ServerResponse, repo: RepoRec, body: Record<string, unknown>): void {
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    // A rename moves the record so later reads under the new name resolve.
    repos.delete(repoKey(repo.owner, repo.name));
    repo.name = body.name;
    repos.set(repoKey(repo.owner, repo.name), repo);
  }
  sendJson(res, 200, repoJson(repo));
}

// ---------------------------------------------------------------- contents

interface ContentsBody {
  message: string;
  content?: string;
  branch?: string;
  sha?: string;
}

function contentsBranch(body: Record<string, unknown>, repo: RepoRec): string {
  const branch = stringField(body, 'branch');
  return branch === '' ? repo.defaultBranch : branch;
}

function handlePutContents(res: ServerResponse, repo: RepoRec, path: string, body: Record<string, unknown>): void {
  const parsed = body as unknown as ContentsBody;
  const branch = contentsBranch(body, repo);
  const tip = branchTip(repo, branch);
  const files = filesAtCommit(tip);
  const existing = files.get(path);
  if (existing !== undefined) {
    if (typeof parsed.sha !== 'string' || parsed.sha === '') {
      throw new ApiError(422, 'sha is required when updating an existing file');
    }
    if (parsed.sha !== existing.oid) throw new ApiError(409, 'sha does not match the current blob');
  }
  const content = typeof parsed.content === 'string' ? fromBase64(parsed.content) : Buffer.alloc(0);
  const blobOid = putObject('blob', content);
  const message = parsed.message !== '' && typeof parsed.message === 'string' ? parsed.message : `Update ${path}`;
  const commit = commitOnBranch(repo, branch, new Map([[path, blobOid]]), message);
  sendJson(res, existing === undefined ? 201 : 200, {
    content: { name: path.split('/').pop() as string, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: commit, message },
  });
}

function handleGetContents(res: ServerResponse, repo: RepoRec, path: string, query: URLSearchParams): void {
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  const files = filesAtCommit(tip);
  const file = files.get(path);
  if (file !== undefined) {
    const obj = objects.get(file.oid);
    const data = obj === undefined ? Buffer.alloc(0) : obj.data;
    sendJson(res, 200, {
      name: path.split('/').pop() as string,
      path,
      sha: file.oid,
      size: data.length,
      type: 'file',
      encoding: 'base64',
      content: toBase64(data),
    });
    return;
  }
  // A directory: the entries directly under it.
  const prefix = path === '' ? '' : `${path}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.set(rest, { type: 'file', sha: entry.oid });
    else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) entries.set(dirName, { type: 'dir', sha: entry.oid });
    }
  }
  if (entries.size === 0 && path !== '') throw new ApiError(404, 'Not Found');
  const list = [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({ name, path: `${prefix}${name}`, sha: entry.sha, size: 0, type: entry.type }));
  sendJson(res, 200, list);
}

function handleDeleteContents(res: ServerResponse, repo: RepoRec, path: string, body: Record<string, unknown>): void {
  const branch = contentsBranch(body, repo);
  const tip = branchTip(repo, branch);
  const files = filesAtCommit(tip);
  const existing = files.get(path);
  if (existing === undefined) throw new ApiError(404, 'Not Found');
  const sha = stringField(body, 'sha');
  if (sha !== '' && sha !== existing.oid) throw new ApiError(409, 'sha does not match the current blob');
  const message = stringField(body, 'message') || `Delete ${path}`;
  const commit = commitOnBranch(repo, branch, new Map([[path, null]]), message);
  sendJson(res, 200, { content: null, commit: { sha: commit, message } });
}

// ---------------------------------------------------------------- refs, branches, commits

function handleCreateRef(res: ServerResponse, repo: RepoRec, body: Record<string, unknown>): void {
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (!ref.startsWith('refs/') || sha === '') throw new ApiError(422, 'ref and sha are required');
  repo.refs.set(ref, sha);
  sendJson(res, 201, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: 'commit' } });
}

function handleListBranches(res: ServerResponse, repo: RepoRec): void {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: derefTag(oid) }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(res, 200, branches);
}

function handleGetBranch(res: ServerResponse, repo: RepoRec, branch: string): void {
  const tip = branchTip(repo, branch);
  if (tip === undefined) throw new ApiError(404, 'Branch not found');
  sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
}

function handleGetRef(res: ServerResponse, repo: RepoRec, ref: string): void {
  const oid = repo.refs.get(ref);
  if (oid === undefined) throw new ApiError(404, 'Reference not found');
  sendJson(res, 200, { ref, node_id: `REF_${ref}`, url: '', object: { sha: oid, type: objects.get(oid)?.type ?? 'commit' } });
}

function handleListCommits(res: ServerResponse, repo: RepoRec, query: URLSearchParams): void {
  const shaParam = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, shaParam);
  if (tip === undefined) {
    sendJson(res, 200, []);
    return;
  }
  const commits = listCommits(tip, 100).map((oid) => {
    const view = parseCommit((objects.get(oid) as { data: Buffer }).data);
    return { sha: oid, commit: { message: view.message, author: { name: view.author }, committer: { name: view.committer }, tree: { sha: view.tree } }, parents: view.parents.map((p) => ({ sha: p })) };
  });
  sendJson(res, 200, commits);
}

// ---------------------------------------------------------------- labels and issues

function handleCreateLabel(res: ServerResponse, repo: RepoRec, body: Record<string, unknown>): void {
  const name = stringField(body, 'name');
  if (name === '') throw new ApiError(422, 'name is required');
  const color = stringField(body, 'color') || 'ededed';
  const label = { name, color };
  repo.labels.set(name, label);
  sendJson(res, 201, { name: label.name, color: label.color, description: null, default: false });
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function checkedLabels(repo: RepoRec, body: Record<string, unknown>): string[] {
  const names = labelNamesOf(body);
  for (const name of names) {
    if (!repo.labels.has(name)) throw new ApiError(422, `Label "${name}" does not exist on this repository`);
  }
  return names;
}

function handleCreateIssue(res: ServerResponse, repo: RepoRec, body: Record<string, unknown>): void {
  const labels = checkedLabels(repo, body);
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    number,
    id: freshIssueId(),
    title: stringField(body, 'title'),
    body: stringField(body, 'body'),
    state: 'open',
    labels,
    comments: [],
  };
  repo.issues.set(number, issue);
  sendJson(res, 201, issueJson(repo, issue));
}

function needIssue(repo: RepoRec, number: number): IssueRec {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new ApiError(404, 'Issue not found');
  return issue;
}

function handleListIssues(res: ServerResponse, repo: RepoRec, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  sendJson(res, 200, issues.map((issue) => issueJson(repo, issue)));
}

function handlePatchIssue(res: ServerResponse, repo: RepoRec, issue: IssueRec, body: Record<string, unknown>): void {
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (body.labels !== undefined) issue.labels = checkedLabels(repo, body);
  sendJson(res, 200, issueJson(repo, issue));
}

// ---------------------------------------------------------------- pull requests

function handleCreatePull(res: ServerResponse, repo: RepoRec, body: Record<string, unknown>): void {
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (head === '' || base === '') throw new ApiError(422, 'head and base are required');
  if (branchTip(repo, head) === undefined) throw new ApiError(422, `Head branch "${head}" does not exist`);
  if (branchTip(repo, base) === undefined) throw new ApiError(422, `Base branch "${base}" does not exist`);
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    number,
    id: freshIssueId(),
    title: stringField(body, 'title'),
    body: stringField(body, 'body'),
    head,
    base,
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
  };
  repo.pulls.set(number, pull);
  sendJson(res, 201, pullJson(repo, pull));
}

function needPull(repo: RepoRec, number: number): PullRec {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new ApiError(404, 'Pull request not found');
  return pull;
}

/** The mergeability of a pull right now: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'. */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  // Probe the same three-way merge the squash will perform: building its tree only stores
  // content-addressed objects and never moves a ref, so probing is side-effect free.
  const result = threeWayMerge(repo, baseTip, headTip);
  return 'conflict' in result ? 'CONFLICTING' : 'MERGEABLE';
}

function handlePullFiles(res: ServerResponse, repo: RepoRec, pull: PullRec): void {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  const base = baseTip !== undefined && headTip !== undefined ? mergeBase(baseTip, headTip) ?? baseTip : baseTip;
  const diffs = diffCommits(base, headTip);
  const files = diffs.map((diff) => {
    const additions = diff.headOid === null ? 0 : countLines(diff.headOid);
    const deletions = diff.baseOid === null ? 0 : countLines(diff.baseOid);
    return {
      filename: diff.path,
      status: diff.status === 'modified' ? 'modified' : diff.status,
      additions: diff.status === 'added' ? Math.max(1, additions) : additions,
      deletions,
      changes: additions + deletions,
      sha: diff.headOid ?? diff.baseOid ?? '',
    };
  });
  sendJson(res, 200, files);
}

function countLines(blobOid: string): number {
  const obj = objects.get(blobOid);
  if (obj === undefined) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}

function handleMergePull(res: ServerResponse, repo: RepoRec, pull: PullRec): void {
  if (pull.merged) {
    sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  const sha = squashMerge(repo, pull);
  if (sha === null) throw new ApiError(405, 'Pull Request is not mergeable');
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoNow();
  sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------- dispatcher

/** Route one /api/v3 request. `segments` is the path after /api/v3, split and decoded. */
export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  rawBody: Buffer,
): void {
  const method = req.method ?? 'GET';
  const body = (): Record<string, unknown> => parseJsonObject(rawBody);
  const [s0, s1, s2, s3, s4] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues{/number}',
    }, { 'x-oauth-scopes': SCOPES });
    return;
  }
  if (s0 === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false });
    return;
  }
  if (s0 === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }
  if (s0 === 'user' && s1 === 'repos' && segments.length === 2) {
    if (method === 'POST') { handleCreateRepo(res, body()); return; }
    if (method === 'GET') { handleListUserRepos(req, res, query); return; }
    throw new ApiError(404, 'Not Found');
  }
  if (s0 !== 'repos' || s1 === undefined || s2 === undefined) throw new ApiError(404, 'Not Found');

  const owner = s1;
  const name = s2;
  if (segments.length === 3) {
    const repo = needRepo(owner, name);
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') { handlePatchRepo(res, repo, body()); return; }
    if (method === 'DELETE') { deleteRepo(owner, name); sendEmpty(res, 204); return; }
    throw new ApiError(404, 'Not Found');
  }

  const repo = needRepo(owner, name);
  const tail = segments.slice(3);

  if (tail[0] === 'contents') {
    const path = tail.slice(1).map(decodeSegment).join('/');
    if (method === 'PUT') { handlePutContents(res, repo, path, body()); return; }
    if (method === 'GET') { handleGetContents(res, repo, path, query); return; }
    if (method === 'DELETE') { handleDeleteContents(res, repo, path, body()); return; }
    throw new ApiError(404, 'Not Found');
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && method === 'POST' && tail.length === 2) {
    handleCreateRef(res, repo, body());
    return;
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && method === 'GET' && tail.length > 2) {
    handleGetRef(res, repo, `refs/${tail.slice(2).map(decodeSegment).join('/')}`);
    return;
  }
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') { handleListBranches(res, repo); return; }
  if (tail[0] === 'branches' && tail.length > 1 && method === 'GET') {
    handleGetBranch(res, repo, tail.slice(1).map(decodeSegment).join('/'));
    return;
  }
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') { handleListCommits(res, repo, query); return; }
  if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') { handleCreateLabel(res, repo, body()); return; }
  if (tail[0] === 'labels' && tail.length === 1 && method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: null, default: false })));
    return;
  }
  if (tail[0] === 'issues' && tail.length === 1) {
    if (method === 'POST') { handleCreateIssue(res, repo, body()); return; }
    if (method === 'GET') { handleListIssues(res, repo, query); return; }
    throw new ApiError(404, 'Not Found');
  }
  if (tail[0] === 'issues' && tail.length === 2) {
    const issue = needIssue(repo, Number(tail[1]));
    if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
    if (method === 'PATCH') { handlePatchIssue(res, repo, issue, body()); return; }
    throw new ApiError(404, 'Not Found');
  }
  if (tail[0] === 'issues' && tail.length === 3 && tail[2] === 'comments') {
    const issue = needIssue(repo, Number(tail[1]));
    if (method === 'POST') {
      const comment = { id: freshCommentId(), body: stringField(body(), 'body') };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
      return;
    }
    if (method === 'GET') { sendJson(res, 200, issue.comments.map(commentJson)); return; }
    throw new ApiError(404, 'Not Found');
  }
  if (tail[0] === 'pulls' && tail.length === 1) {
    if (method === 'POST') { handleCreatePull(res, repo, body()); return; }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      sendJson(res, 200, pulls.map((pull) => pullJson(repo, pull)));
      return;
    }
    throw new ApiError(404, 'Not Found');
  }
  if (tail[0] === 'pulls' && tail.length === 2) {
    const pull = needPull(repo, Number(tail[1]));
    if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
    throw new ApiError(404, 'Not Found');
  }
  if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'files' && method === 'GET') {
    handlePullFiles(res, repo, needPull(repo, Number(tail[1])));
    return;
  }
  if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
    handleMergePull(res, repo, needPull(repo, Number(tail[1])));
    return;
  }
  void s3;
  void s4;
  throw new ApiError(404, 'Not Found');
}



