# github-core-clone-01 — a GitHub-compatible git forge

One Node process, standard library only, no git binary. `main.ts` starts the server on an
ephemeral port, registers the port with the trial env (`$MAKEFUN_ENV_URL/register`), serves until
the env's `/done` answers true, and exits 0.

## Surfaces

- **Git smart HTTP** (`/{owner}/{repo}.git/…`): ref advertisement in protocol v2 (with
  `ls-refs` and `fetch`, including shallow and deepen negotiation) and the v0 fallback with
  side-band-64k; receive-pack v0 with report-status, delete-refs and fast-forward-only
  enforcement. Objects are content-addressed SHA-1, packs are read and written in-process.
- **REST v3** (`/api/v3`): repositories (create/list with Link pagination/get/patch/delete),
  contents (PUT/GET/DELETE backed by real git commits, with sha conflict semantics), git refs,
  branches, commits, labels, issues and comments, pull requests with a squash merge (405 on
  conflict).
- **GraphQL** (`/api/graphql`): viewer, repository lookups, issue/pull connections with cursor
  pagination, the introspection surface, and the create/close/merge/comment mutations; batched
  operations are answered in order.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP with `server/discover` (2026-07-28) and six
  tools over the same store as REST.

State is in-memory and deterministic: ids and timestamps derive from counters, never clocks, so
the same request sequence always produces the same state.

## Layout

- `main.ts` — the trial lifecycle (register, serve, done).
- `app.ts` — HTTP routing and the bearer-token gate.
- `scenario.ts` — the suite's seeded identity, re-derived (the token owner's login).
- `store.ts` — the object store, repository records, global ids, merges.
- `git.ts` — pkt-lines, packfiles, upload-pack / receive-pack.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — the GraphQL engine and schema.
- `mcp.ts` — the MCP endpoint and its tools.
- `util.ts` — shared HTTP plumbing.
