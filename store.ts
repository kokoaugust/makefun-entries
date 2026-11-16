// The forge's store: a content-addressed git object store plus the repository records the REST,
// GraphQL and MCP surfaces share. Everything lives in memory — the trial pod gives the process a
// gigabyte and the suite's data is small — and every value the state could be compared on is a
// deterministic function of the requests served (counters, never clocks).

import { createHash } from 'node:crypto';
import { VIEWER } from './scenario.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** Every object the forge holds, by id: one store for all repositories (ids are content hashes). */
export const objects = new Map<string, GitObj>();

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store one object and answer its id. */
export function putObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObj | undefined {
  return objects.get(oid);
}

// ---------------------------------------------------------------- trees and commits

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries (sorted the way git sorts them) and store it. */
export function buildTree(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject('tree', Buffer.concat(parts));
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

/** Build and store a commit; the message is stored byte-exactly as given. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): string {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  return putObject('commit', Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8'));
}

/** Flatten a tree into path -> {oid, mode} for files (directories are traversed, not listed). */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree from a flat path -> blob-oid map; answers the root tree id. */
export function buildTreeFromFiles(files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return buildTree(entries);
  };
  return build(root);
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from a commit (itself, its ancestors, their trees and blobs). */
export function commitClosure(tip: string): Set<string> {
  const seen = new Set<string>();
  const commits: string[] = [tip];
  const trees: string[] = [];
  while (commits.length > 0) {
    const oid = commits.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    const view = parseCommit(obj.data);
    commits.push(...view.parents);
    if (!seen.has(view.tree)) trees.push(view.tree);
  }
  const walkTrees = [...trees];
  while (walkTrees.length > 0) {
    const oid = walkTrees.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    seen.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walkTrees.push(entry.oid);
      else seen.add(entry.oid);
    }
  }
  return seen;
}

/** Just the trees (and subtrees) under a tree — what a shallow fetch still owes the client. */
export function treeClosure(treeOid: string): Set<string> {
  const seen = new Set<string>();
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    seen.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else seen.add(entry.oid);
    }
  }
  return seen;
}

/** Whether `ancestor` is `tip` itself or reachable from it through parents. */
export function isAncestor(ancestor: string, tip: string): boolean {
  const stack = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** A best common ancestor of two commits (breadth-first from both sides), or null. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const set = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (set.has(oid)) continue;
      const obj = objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      set.add(oid);
      stack.push(...parseCommit(obj.data).parents);
    }
    return set;
  };
  const fromA = ancestorsOf(a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** The commits on a ref's ancestry, newest first (the commits-listing walk). */
export function listCommits(tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}

// ---------------------------------------------------------------- repository records

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
}

export interface RepoRec {
  dbId: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name (refs/heads/…, refs/tags/…) -> object id. */
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one per-repository numbering sequence. */
  nextNumber: number;
}

/** All repositories, keyed `owner/name`. */
export const repos = new Map<string, RepoRec>();
const reposByDbId = new Map<number, RepoRec>();

let nextRepoDbId = 1;
let nextIssueGlobalId = 1;
let nextCommentGlobalId = 1;
let logicalTick = 0;

/** The forge's deterministic clock base: 2025-01-01T00:00:00Z, advanced by counters only. */
const EPOCH_BASE_SEC = 1_735_689_600;

/** Advance the logical clock and answer the new timestamp (seconds). */
export function nextTimestamp(): number {
  logicalTick += 1;
  return EPOCH_BASE_SEC + logicalTick * 61;
}

/** An ISO timestamp for the current logical tick (REST/GraphQL date fields). */
export function isoNow(): string {
  return new Date((EPOCH_BASE_SEC + logicalTick * 61) * 1000).toISOString().replace('.000Z', 'Z');
}

/** The identity forge-side commits (contents writes, merges) are authored under. */
export const FORGE_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
  const key = repoKey(VIEWER.login, name);
  if (repos.has(key)) return null;
  const repo: RepoRec = {
    dbId: nextRepoDbId,
    name,
    owner: VIEWER.login,
    isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoDbId += 1;
  repos.set(key, repo);
  reposByDbId.set(repo.dbId, repo);
  return repo;
}

export function getRepo(owner: string, name: string): RepoRec | undefined {
  return repos.get(repoKey(owner, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  const repo = getRepo(owner, name);
  if (repo === undefined) return false;
  repos.delete(repoKey(owner, name));
  reposByDbId.delete(repo.dbId);
  return true;
}

export function repoByDbId(dbId: number): RepoRec | undefined {
  return reposByDbId.get(dbId);
}

/** The viewer's repositories, in creation order (databaseId order). */
export function viewerRepos(): RepoRec[] {
  return [...repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.dbId - b.dbId);
}

export function freshIssueId(): number {
  const id = nextIssueGlobalId;
  nextIssueGlobalId += 1;
  return id;
}

export function freshCommentId(): number {
  const id = nextCommentGlobalId;
  nextCommentGlobalId += 1;
  return id;
}

// ---------------------------------------------------------------- global ids

// Relay-style global ids: opaque base64 of a typed payload, so an id never equals the bare
// databaseId or number it wraps, yet decodes back to the same record on every surface.

function encodeGlobalId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

export function repoGlobalId(repo: RepoRec): string {
  return encodeGlobalId(`Repository:${repo.dbId}`);
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return encodeGlobalId(`Issue:${repo.dbId}:${issue.number}`);
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return encodeGlobalId(`PullRequest:${repo.dbId}:${pull.number}`);
}

export function commentGlobalId(repo: RepoRec, issue: IssueRec, comment: CommentRec): string {
  return encodeGlobalId(`IssueComment:${repo.dbId}:${issue.number}:${comment.id}`);
}

export type DecodedGlobalId =
  | { kind: 'Repository'; repo: RepoRec }
  | { kind: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { kind: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { kind: 'IssueComment'; repo: RepoRec; issue: IssueRec; comment: CommentRec };

/** Resolve a global id back to its record, or undefined when it names nothing here. */
export function decodeGlobalId(id: string): DecodedGlobalId | undefined {
  let payload: string;
  try {
    payload = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const parts = payload.split(':');
  const kind = parts[0];
  const repo = reposByDbId.get(Number(parts[1]));
  if (repo === undefined) return undefined;
  if (kind === 'Repository') return { kind, repo };
  if (kind === 'Issue') {
    const issue = repo.issues.get(Number(parts[2]));
    return issue === undefined ? undefined : { kind, repo, issue };
  }
  if (kind === 'PullRequest') {
    const pull = repo.pulls.get(Number(parts[2]));
    return pull === undefined ? undefined : { kind, repo, pull };
  }
  if (kind === 'IssueComment') {
    const issue = repo.issues.get(Number(parts[2]));
    const comment = issue?.comments.find((c) => c.id === Number(parts[3]));
    return issue === undefined || comment === undefined ? undefined : { kind, repo, issue, comment };
  }
  return undefined;
}

// ---------------------------------------------------------------- branch commits and merges

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchTip(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get(branchRef(branch));
}

/** The flat file map of a commit's tree (empty for an unborn branch). */
export function filesAtCommit(commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  if (commitOid === undefined) return new Map();
  const obj = objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree);
}

/**
 * Commit file changes onto a branch: `changes` maps a path to a new blob id, or null to delete it.
 * Creates the branch's first commit when the branch is unborn. Answers the new commit id.
 */
export function commitOnBranch(
  repo: RepoRec,
  branch: string,
  changes: ReadonlyMap<string, string | null>,
  message: string,
): string {
  const tip = branchTip(repo, branch);
  const files = new Map<string, string>();
  for (const [path, entry] of filesAtCommit(tip)) files.set(path, entry.oid);
  for (const [path, oid] of changes) {
    if (oid === null) files.delete(path);
    else files.set(path, oid);
  }
  const tree = buildTreeFromFiles(files);
  const commit = buildCommit({
    tree,
    parents: tip === undefined ? [] : [tip],
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    timestamp: nextTimestamp(),
    message,
  });
  repo.refs.set(branchRef(branch), commit);
  return commit;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  baseOid: string | null;
  headOid: string | null;
}

/** The file-level diff between two commits' trees. */
export function diffCommits(baseOid: string | undefined, headOid: string | undefined): FileDiff[] {
  const baseFiles = filesAtCommit(baseOid);
  const headFiles = filesAtCommit(headOid);
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head === undefined) diffs.push({ path, status: 'removed', baseOid: base.oid, headOid: null });
    else if (base === undefined && head !== undefined) diffs.push({ path, status: 'added', baseOid: null, headOid: head.oid });
    else if (base !== undefined && head !== undefined && base.oid !== head.oid) diffs.push({ path, status: 'modified', baseOid: base.oid, headOid: head.oid });
  }
  return diffs;
}

/**
 * A three-way merge of two branch tips against their merge base, at file granularity: a path one
 * side changed takes that side's version; a path both sides changed differently is a conflict.
 * Answers the merged tree id, or the conflicting paths.
 */
export function threeWayMerge(
  repo: RepoRec,
  baseTip: string,
  headTip: string,
): { tree: string } | { conflict: string[] } {
  const base = mergeBase(baseTip, headTip);
  const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : filesAtCommit(base);
  const oursFiles = filesAtCommit(baseTip);
  const theirsFiles = filesAtCommit(headTip);
  const merged = new Map<string, string>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const o = oursFiles.get(path)?.oid ?? null;
    const t = theirsFiles.get(path)?.oid ?? null;
    if (o === t) {
      if (o !== null) merged.set(path, o);
    } else if (b === o) {
      if (t !== null) merged.set(path, t);
    } else if (b === t) {
      if (o !== null) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { conflict: conflicts };
  void repo;
  return { tree: buildTreeFromFiles(merged) };
}

/**
 * Squash-merge a pull request: one new commit on the base branch carrying the head branch's net
 * diff against the merge base. Answers the merge commit id, or null on conflict.
 */
export function squashMerge(repo: RepoRec, pull: PullRec): string | null {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === undefined || headTip === undefined) return null;
  const result = threeWayMerge(repo, baseTip, headTip);
  if ('conflict' in result) return null;
  const commit = buildCommit({
    tree: result.tree,
    parents: [baseTip],
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    timestamp: nextTimestamp(),
    message: `${pull.title}\n\n${pull.body}`.trimEnd(),
  });
  repo.refs.set(branchRef(pull.base), commit);
  return commit;
}



