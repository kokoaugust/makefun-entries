// The GraphQL surface at /api/graphql. The suite speaks a fixed family of documents, so this is a
// small complete engine for them: a lexer and parser for queries, mutations, variables, input
// objects, enums and inline fragments, and an executor over the same store REST uses. Unknown
// fields answer HTTP 200 with an errors entry naming the field; an unknown repository answers
// data.repository = null with no errors; a batched body (a JSON array) answers an array in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  branchTip, commentGlobalId, decodeGlobalId, diffCommits, freshCommentId, freshIssueId, getRepo, issueGlobalId,
  mergeBase, pullGlobalId, repoGlobalId, squashMerge, isoNow,
  type IssueRec, type PullRec, type RepoRec,
} from './store.ts';
import { pullMergeable } from './rest.ts';
import { ApiError, parseJsonObject, sendJson } from './util.ts';

// ---------------------------------------------------------------- lexer and parser

type Token = { kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

interface ValueNode { kind: 'var' | 'string' | 'int' | 'float' | 'bool' | 'enum' | 'null' | 'list' | 'object'; value?: unknown; items?: ValueNode[]; fields?: Map<string, ValueNode> }
interface FieldNode { name: string; alias?: string; args: Map<string, ValueNode>; selection: FieldNode[]; fragmentType?: string }

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private take(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.atPunct(value)) throw new Error(`Expected "${value}"`);
    this.pos += 1;
  }

  parseDocument(): { operation: 'query' | 'mutation'; selection: FieldNode[] } {
    let operation: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = this.take().value as 'query' | 'mutation';
      // Optional operation name and variable definitions.
      if (this.peek()?.kind === 'name') this.take();
      if (this.atPunct('(')) this.skipBalanced();
    }
    const selection = this.parseSelectionSet();
    return { operation, selection };
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.take();
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      if (token.value === ')' || token.value === ']' || token.value === '}') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'spread') {
        this.take();
        const on = this.take(); // 'on'
        void on;
        const typeName = this.take().value;
        const inner = this.parseSelectionSet();
        fields.push({ name: '__fragment', args: new Map(), selection: inner, fragmentType: typeName });
        continue;
      }
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    let name = this.take().value;
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.take();
      alias = name;
      name = this.take().value;
    }
    const args = new Map<string, ValueNode>();
    if (this.atPunct('(')) {
      this.take();
      while (!this.atPunct(')')) {
        const argName = this.take().value;
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    // Directives are skipped.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.take();
      this.take();
      if (this.atPunct('(')) this.skipBalanced();
    }
    let selection: FieldNode[] = [];
    if (this.atPunct('{')) selection = this.parseSelectionSet();
    return { name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.take();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', value: this.take().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.atPunct('}')) {
        const key = this.take().value;
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    return { kind: 'null' };
  }
}

function resolveValue(node: ValueNode | undefined, vars: Record<string, unknown>): unknown {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case 'var': return vars[node.value as string];
    case 'list': return (node.items ?? []).map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields ?? new Map()) out[key] = resolveValue(value, vars);
      return out;
    }
    default: return node.value;
  }
}

function argOf(field: FieldNode, vars: Record<string, unknown>, name: string): unknown {
  return resolveValue(field.args.get(name), vars);
}

// ---------------------------------------------------------------- schema tables

interface TypeField { name: string; type: string }

function fieldsOf(pairs: ReadonlyArray<readonly [string, string]>): TypeField[] {
  return pairs.map(([name, type]) => ({ name, type }));
}

const TYPE_FIELDS: Record<string, TypeField[]> = {
  Query: fieldsOf([
    ['viewer', 'User'], ['repository', 'Repository'], ['node', 'Node'], ['search', 'SearchResultItemConnection'],
    ['rateLimit', 'RateLimit'], ['meta', 'GitHubMetadata'], ['organization', 'Organization'], ['user', 'User'],
  ]),
  Mutation: fieldsOf([
    ['createIssue', 'CreateIssuePayload'], ['closeIssue', 'CloseIssuePayload'], ['createPullRequest', 'CreatePullRequestPayload'],
    ['mergePullRequest', 'MergePullRequestPayload'], ['addComment', 'AddCommentPayload'], ['updateIssue', 'UpdateIssuePayload'],
    ['createRepository', 'CreateRepositoryPayload'],
  ]),
  User: fieldsOf([
    ['id', 'ID'], ['login', 'String'], ['name', 'String'], ['email', 'String'], ['avatarUrl', 'URI'],
    ['url', 'URI'], ['repositories', 'RepositoryConnection'], ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'],
  ]),
  Repository: fieldsOf([
    ['id', 'ID'], ['databaseId', 'Int'], ['name', 'String'], ['nameWithOwner', 'String'], ['owner', 'RepositoryOwner'],
    ['defaultBranchRef', 'Ref'], ['viewerPermission', 'RepositoryPermission'], ['hasIssuesEnabled', 'Boolean'],
    ['hasPullRequestsEnabled', 'Boolean'], ['isPrivate', 'Boolean'], ['description', 'String'], ['url', 'URI'],
    ['issue', 'Issue'], ['issues', 'IssueConnection'], ['pullRequest', 'PullRequest'], ['pullRequests', 'PullRequestConnection'],
    ['labels', 'LabelConnection'], ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'], ['pushedAt', 'DateTime'],
  ]),
  Issue: fieldsOf([
    ['id', 'ID'], ['databaseId', 'Int'], ['number', 'Int'], ['title', 'String'], ['body', 'String'], ['state', 'IssueState'],
    ['author', 'Actor'], ['labels', 'LabelConnection'], ['comments', 'IssueCommentConnection'], ['url', 'URI'],
    ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'], ['closedAt', 'DateTime'], ['repository', 'Repository'],
  ]),
  PullRequest: fieldsOf([
    ['id', 'ID'], ['databaseId', 'Int'], ['number', 'Int'], ['title', 'String'], ['body', 'String'], ['state', 'PullRequestState'],
    ['headRefName', 'String'], ['baseRefName', 'String'], ['headRef', 'Ref'], ['baseRef', 'Ref'], ['mergeable', 'MergeableState'],
    ['merged', 'Boolean'], ['mergedAt', 'DateTime'], ['mergeCommit', 'Commit'], ['files', 'PullRequestChangedFileConnection'],
    ['author', 'Actor'], ['url', 'URI'], ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'], ['repository', 'Repository'],
    ['additions', 'Int'], ['deletions', 'Int'], ['changedFiles', 'Int'],
  ]),
  Ref: fieldsOf([['id', 'ID'], ['name', 'String'], ['prefix', 'String'], ['target', 'GitObject']]),
  Commit: fieldsOf([['id', 'ID'], ['oid', 'GitObjectID'], ['message', 'String'], ['committedDate', 'DateTime'], ['author', 'GitActor']]),
  IssueComment: fieldsOf([['id', 'ID'], ['databaseId', 'Int'], ['body', 'String'], ['author', 'Actor'], ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'], ['url', 'URI']]),
  Label: fieldsOf([['id', 'ID'], ['name', 'String'], ['color', 'String'], ['description', 'String']]),
  PageInfo: fieldsOf([['hasNextPage', 'Boolean'], ['hasPreviousPage', 'Boolean'], ['startCursor', 'String'], ['endCursor', 'String']]),
  SearchResultItemConnection: fieldsOf([['issueCount', 'Int'], ['nodes', '[SearchResultItem]'], ['edges', '[SearchResultItemEdge]'], ['pageInfo', 'PageInfo']]),
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'],
  CommentAuthorAssociation: ['OWNER', 'MEMBER', 'NONE'],
  State: ['OPEN', 'CLOSED'],
};

// ---------------------------------------------------------------- execution

interface Ctx {
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type GqlObj = Record<string, unknown> & { __type: string };

function obj(type: string, fields: Record<string, unknown>): GqlObj {
  return { __type: type, ...fields };
}

/** Encode a pagination cursor (an opaque offset). */
function cursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(value, 'base64').toString('utf8'));
  return match === null ? 0 : Number.parseInt(match[1] as string, 10);
}

/** Wrap a list in a connection with cursors and a PageInfo, honouring first/after. */
function connection(type: string, items: GqlObj[], field: FieldNode, ctx: Ctx): GqlObj {
  const firstArg = argOf(field, ctx.vars, 'first');
  const first = typeof firstArg === 'number' ? firstArg : items.length;
  const start = decodeCursor(argOf(field, ctx.vars, 'after'));
  const slice = items.slice(start, start + first);
  const hasNext = start + first < items.length;
  const edges = slice.map((node, index) => obj(`${type}Edge`, { node, cursor: cursor(start + index + 1) }));
  return obj(type, {
    nodes: slice,
    edges,
    totalCount: items.length,
    pageInfo: obj('PageInfo', {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as GqlObj).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as GqlObj).cursor : null,
    }),
  });
}

// ---------------------------------------------------------------- value objects

function viewerObj(): GqlObj {
  return obj('User', {
    id: `U_${VIEWER.id}`,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    avatarUrl: 'https://forge.invalid/avatar.png',
    url: 'https://forge.invalid/',
    createdAt: isoNow(),
    updatedAt: isoNow(),
  });
}

function repoObj(repo: RepoRec): GqlObj {
  const tip = branchTip(repo, repo.defaultBranch);
  return obj('Repository', {
    __repo: repo,
    id: repoGlobalId(repo),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: obj('User', { id: `U_${VIEWER.id}`, login: repo.owner, name: VIEWER.name }),
    defaultBranchRef: tip === undefined ? null : obj('Ref', { id: `REF_${repo.dbId}_${repo.defaultBranch}`, name: repo.defaultBranch, prefix: 'refs/heads/', target: obj('Commit', { id: tip, oid: tip }) }),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasPullRequestsEnabled: true,
    isPrivate: repo.isPrivate,
    description: repo.description,
    url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    pushedAt: isoNow(),
  });
}

function issueObj(repo: RepoRec, issue: IssueRec): GqlObj {
  return obj('Issue', {
    __repo: repo,
    __issue: issue,
    id: issueGlobalId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    author: obj('User', { id: `U_${VIEWER.id}`, login: VIEWER.login, name: VIEWER.name }),
    url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    closedAt: issue.state === 'closed' ? isoNow() : null,
    repository: repoObj(repo),
  });
}

function pullObj(repo: RepoRec, pull: PullRec): GqlObj {
  const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
  return obj('PullRequest', {
    __repo: repo,
    __pull: pull,
    id: pullGlobalId(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: refObj(repo, pull.head),
    baseRef: refObj(repo, pull.base),
    mergeable: pullMergeable(repo, pull),
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommitSha === null ? null : obj('Commit', { id: pull.mergeCommitSha, oid: pull.mergeCommitSha }),
    author: obj('User', { id: `U_${VIEWER.id}`, login: VIEWER.login, name: VIEWER.name }),
    url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    repository: repoObj(repo),
    additions: 0,
    deletions: 0,
    changedFiles: 0,
  });
}

function refObj(repo: RepoRec, branch: string): GqlObj | null {
  const tip = branchTip(repo, branch);
  if (tip === undefined) return null;
  return obj('Ref', { id: `REF_${repo.dbId}_${branch}`, name: branch, prefix: 'refs/heads/', target: obj('Commit', { id: tip, oid: tip }) });
}

// ---------------------------------------------------------------- field resolution

function unknownField(ctx: Ctx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Field '${fieldName}' doesn't exist on type '${typeName}'` });
  return null;
}

/** Execute a selection set against an object of a named type. */
function execSelection(target: GqlObj | null, typeName: string, selection: FieldNode[], ctx: Ctx): Record<string, unknown> | null {
  if (target === null) return null;
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    if (field.name === '__fragment') {
      if (field.fragmentType === typeName || field.fragmentType === 'Node' || field.fragmentType === 'Repository' || field.fragmentType === 'Issue' || field.fragmentType === 'PullRequest') {
        const inner = execSelection(target, field.fragmentType as string, field.selection, ctx);
        if (inner !== null) Object.assign(out, inner);
      }
      continue;
    }
    out[key] = resolveField(target, typeName, field, ctx);
  }
  return out;
}

function resolveField(target: GqlObj, typeName: string, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__typename') return typeName;
  if (name === '__type') return resolveTypeQuery(field, ctx);
  if (name === '__schema') return schemaObj(field, ctx);
  // Computed fields (connections, lookups) resolve against the store first.
  if (isComputedField(typeName, name)) return computeField(target, typeName, field, ctx);
  // Stored scalar/object values answer directly.
  if (!(name in target)) return unknownField(ctx, typeName, name);
  const stored = target[name];
  if (field.selection.length === 0) return stored ?? null;
  // Object-valued fields recurse with the field's declared type.
  const childType = childTypeOf(typeName, name);
  if (Array.isArray(stored)) {
    return stored.map((item) => (item !== null && typeof item === 'object' ? execSelection(item as GqlObj, childType, field.selection, ctx) : item));
  }
  if (stored !== null && typeof stored === 'object') return execSelection(stored as GqlObj, childType, field.selection, ctx);
  return stored ?? null;
}

function isComputedField(typeName: string, name: string): boolean {
  if (typeName === 'Query') return ['viewer', 'repository', 'node', 'search', 'rateLimit'].includes(name);
  if (typeName === 'Mutation') return true;
  if (typeName === 'Repository') return ['issue', 'issues', 'pullRequest', 'pullRequests', 'labels'].includes(name);
  if (typeName === 'PullRequest') return name === 'files';
  if (typeName === 'Issue') return ['labels', 'comments'].includes(name);
  return false;
}

function childTypeOf(typeName: string, name: string): string {
  const declared = (TYPE_FIELDS[typeName] ?? []).find((f) => f.name === name)?.type ?? 'String';
  return declared.replace(/[\[\]!]/g, '');
}

function resolveTypeQuery(field: FieldNode, ctx: Ctx): unknown {
  const typeName = String(argOf(field, ctx.vars, 'name') ?? '');
  const fields = TYPE_FIELDS[typeName];
  const enumValues = ENUM_VALUES[typeName];
  if (fields === undefined && enumValues === undefined) {
    return execSelection(obj('__Type', { name: typeName, kind: 'OBJECT', fields: [], enumValues: [] }), '__Type', field.selection, ctx);
  }
  const typeObj = obj('__Type', {
    name: typeName,
    kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
    fields: (fields ?? []).map((f) => obj('__Field', { name: f.name, type: obj('__Type', { name: f.type, kind: 'SCALAR' }), isDeprecated: false, deprecationReason: null })),
    enumValues: (enumValues ?? []).map((value) => obj('__EnumValue', { name: value, isDeprecated: false, deprecationReason: null })),
  });
  return execSelection(typeObj, '__Type', field.selection, ctx);
}

function schemaObj(field: FieldNode, ctx: Ctx): unknown {
  const types = [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) =>
    obj('__Type', { name, kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT' }));
  const schema = obj('__Schema', {
    types,
    queryType: obj('__Type', { name: 'Query', kind: 'OBJECT' }),
    mutationType: obj('__Type', { name: 'Mutation', kind: 'OBJECT' }),
    subscriptionType: null,
    directives: [],
  });
  return execSelection(schema, '__Schema', field.selection, ctx);
}

/** Resolve a field that is computed from the store rather than stored on its object. */
function computeField(target: GqlObj, typeName: string, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (typeName === 'Repository') {
    const repo = target.__repo as RepoRec;
    if (name === 'issue') {
      const issue = repo.issues.get(Number(argOf(field, ctx.vars, 'number')));
      return issue === undefined ? null : execSelection(issueObj(repo, issue), 'Issue', field.selection, ctx);
    }
    if (name === 'issues') return execSelection(issuesConnection(repo, field, ctx), 'IssueConnection', field.selection, ctx);
    if (name === 'pullRequest') {
      const pull = repo.pulls.get(Number(argOf(field, ctx.vars, 'number')));
      return pull === undefined ? null : execSelection(pullObj(repo, pull), 'PullRequest', field.selection, ctx);
    }
    if (name === 'pullRequests') {
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).map((pull) => pullObj(repo, pull));
      return execSelection(connection('PullRequestConnection', pulls, field, ctx), 'PullRequestConnection', field.selection, ctx);
    }
    if (name === 'labels') {
      const labels = [...repo.labels.values()].map((label) => obj('Label', { id: `L_${label.name}`, name: label.name, color: label.color, description: null }));
      return execSelection(connection('LabelConnection', labels, field, ctx), 'LabelConnection', field.selection, ctx);
    }
  }
  if (typeName === 'Issue') {
    const repo = target.__repo as RepoRec;
    const issue = target.__issue as IssueRec;
    if (name === 'labels') {
      const labels = issue.labels.map((labelName) => obj('Label', { id: `L_${labelName}`, name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed', description: null }));
      return execSelection(connection('LabelConnection', labels, field, ctx), 'LabelConnection', field.selection, ctx);
    }
    if (name === 'comments') {
      const comments = issue.comments.map((comment) => obj('IssueComment', {
        id: commentGlobalId(repo, issue, comment),
        databaseId: comment.id,
        body: comment.body,
        author: obj('User', { id: `U_${VIEWER.id}`, login: VIEWER.login, name: VIEWER.name }),
        createdAt: isoNow(),
        updatedAt: isoNow(),
        url: '',
      }));
      return execSelection(connection('IssueCommentConnection', comments, field, ctx), 'IssueCommentConnection', field.selection, ctx);
    }
  }
  if (typeName === 'PullRequest' && name === 'files') {
    const repo = target.__repo as RepoRec;
    const pull = target.__pull as PullRec;
    // Reuse the REST diff so both surfaces agree on the changed paths.
    const files = pullFilesOf(repo, pull).map((path) => obj('PullRequestChangedFile', { path, additions: 1, deletions: 0, changeType: 'ADDED' }));
    return execSelection(connection('PullRequestChangedFileConnection', files, field, ctx), 'PullRequestChangedFileConnection', field.selection, ctx);
  }
  return null;
}

/** The changed paths of a pull, computed exactly like the REST files listing. */
function pullFilesOf(repo: RepoRec, pull: PullRec): string[] {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === undefined || headTip === undefined) return [];
  const base = mergeBase(baseTip, headTip) ?? baseTip;
  return diffCommits(base, headTip).map((diff) => diff.path);
}

/** repository.issues with the states filter and CREATED_AT ordering (ties by number). */
function issuesConnection(repo: RepoRec, field: FieldNode, ctx: Ctx): GqlObj {
  const statesArg = argOf(field, ctx.vars, 'states');
  const states = Array.isArray(statesArg) ? statesArg.map((s) => String(s).toLowerCase()) : null;
  const orderBy = argOf(field, ctx.vars, 'orderBy') as { field?: string; direction?: string } | undefined;
  let issues = [...repo.issues.values()];
  if (states !== null) issues = issues.filter((issue) => states.includes(issue.state));
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  return connection('IssueConnection', issues.map((issue) => issueObj(repo, issue)), field, ctx);
}

// ---------------------------------------------------------------- root operations

function execRoot(operation: 'query' | 'mutation', selection: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    if (operation === 'mutation') {
      out[key] = execMutation(field, ctx);
      continue;
    }
    switch (field.name) {
      case '__type':
        out[key] = resolveTypeQuery(field, ctx);
        break;
      case '__schema':
        out[key] = schemaObj(field, ctx);
        break;
      case '__typename':
        out[key] = 'Query';
        break;
      case 'viewer':
        out[key] = execSelection(viewerObj(), 'User', field.selection, ctx);
        break;
      case 'repository': {
        const owner = String(argOf(field, ctx.vars, 'owner') ?? '');
        const name = String(argOf(field, ctx.vars, 'name') ?? '');
        const repo = getRepo(owner, name);
        out[key] = repo === undefined ? null : execSelection(repoObj(repo), 'Repository', field.selection, ctx);
        break;
      }
      case 'node': {
        const decoded = decodeGlobalId(String(argOf(field, ctx.vars, 'id') ?? ''));
        if (decoded === undefined) { out[key] = null; break; }
        if (decoded.kind === 'Repository') out[key] = execSelection(repoObj(decoded.repo), 'Repository', field.selection, ctx);
        else if (decoded.kind === 'Issue') out[key] = execSelection(issueObj(decoded.repo, decoded.issue), 'Issue', field.selection, ctx);
        else if (decoded.kind === 'PullRequest') out[key] = execSelection(pullObj(decoded.repo, decoded.pull), 'PullRequest', field.selection, ctx);
        else out[key] = null;
        break;
      }
      case 'search': {
        const empty = obj('SearchResultItemConnection', { issueCount: 0, nodes: [], edges: [], pageInfo: obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) });
        out[key] = execSelection(empty, 'SearchResultItemConnection', field.selection, ctx);
        break;
      }
      case 'rateLimit':
        out[key] = execSelection(obj('RateLimit', { limit: 5000, cost: 1, remaining: 4999, resetAt: isoNow() }), 'RateLimit', field.selection, ctx);
        break;
      default:
        out[key] = unknownField(ctx, 'Query', field.name);
    }
  }
  return out;
}

function execMutation(field: FieldNode, ctx: Ctx): unknown {
  const input = (argOf(field, ctx.vars, 'input') ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === undefined || decoded.kind !== 'Repository') {
        ctx.errors.push({ message: 'repositoryId does not identify a repository' });
        return null;
      }
      const repo = decoded.repo;
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        id: freshIssueId(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
      };
      repo.issues.set(number, issue);
      const payload = obj('CreateIssuePayload', { issue: issueObj(repo, issue), clientMutationId: (input.clientMutationId as string | null) ?? null });
      return execSelection(payload, 'CreateIssuePayload', field.selection, ctx);
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === undefined || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'issueId does not identify an issue' });
        return null;
      }
      decoded.issue.state = 'closed';
      const payload = obj('CloseIssuePayload', { issue: issueObj(decoded.repo, decoded.issue), clientMutationId: (input.clientMutationId as string | null) ?? null });
      return execSelection(payload, 'CloseIssuePayload', field.selection, ctx);
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === undefined || decoded.kind !== 'Repository') {
        ctx.errors.push({ message: 'repositoryId does not identify a repository' });
        return null;
      }
      const repo = decoded.repo;
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        id: freshIssueId(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
      };
      repo.pulls.set(number, pull);
      const payload = obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null });
      return execSelection(payload, 'CreatePullRequestPayload', field.selection, ctx);
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === undefined || decoded.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'pullRequestId does not identify a pull request' });
        return null;
      }
      const sha = squashMerge(decoded.repo, decoded.pull);
      if (sha === null) {
        ctx.errors.push({ message: 'Pull request is not mergeable' });
        return null;
      }
      decoded.pull.merged = true;
      decoded.pull.state = 'closed';
      decoded.pull.mergeCommitSha = sha;
      decoded.pull.mergedAt = isoNow();
      const payload = obj('MergePullRequestPayload', { pullRequest: pullObj(decoded.repo, decoded.pull), clientMutationId: (input.clientMutationId as string | null) ?? null });
      return execSelection(payload, 'MergePullRequestPayload', field.selection, ctx);
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === undefined || (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest')) {
        ctx.errors.push({ message: 'subjectId does not identify a commentable subject' });
        return null;
      }
      const body = String(input.body ?? '');
      if (decoded.kind === 'Issue') {
        const comment = { id: freshCommentId(), body };
        decoded.issue.comments.push(comment);
        const node = obj('IssueComment', {
          id: commentGlobalId(decoded.repo, decoded.issue, comment),
          databaseId: comment.id,
          body,
          author: obj('User', { id: `U_${VIEWER.id}`, login: VIEWER.login, name: VIEWER.name }),
          createdAt: isoNow(),
          updatedAt: isoNow(),
          url: '',
        });
        const payload = obj('AddCommentPayload', {
          commentEdge: obj('IssueCommentEdge', { node, cursor: cursor(1) }),
          subject: issueObj(decoded.repo, decoded.issue),
          clientMutationId: (input.clientMutationId as string | null) ?? null,
        });
        return execSelection(payload, 'AddCommentPayload', field.selection, ctx);
      }
      ctx.errors.push({ message: 'Comments on pull requests are not supported' });
      return null;
    }
    default:
      return unknownField(ctx, 'Mutation', field.name);
  }
}

// ---------------------------------------------------------------- handler

/** Run one GraphQL operation document; answers the {data} / {data, errors} envelope. */
export function runGraphqlOperation(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const vars = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  const ctx: Ctx = { vars, errors: [] };
  let data: Record<string, unknown>;
  try {
    const document = new Parser(query).parseDocument();
    data = execRoot(document.operation, document.selection, ctx);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** POST /api/graphql — one operation, or a batch (an array answered in order). */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  void req;
  const text = rawBody.toString('utf8').trim();
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Malformed JSON body');
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runGraphqlOperation((entry ?? {}) as Record<string, unknown>));
    sendJson(res, 200, results);
    return;
  }
  const envelope = runGraphqlOperation(parseJsonObject(rawBody));
  sendJson(res, 200, envelope);
}



