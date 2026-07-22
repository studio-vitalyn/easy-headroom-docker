# docker-easy-headroom

**Status: early draft.** `docker-compose.yml`, the `headroom` and
`easy-headroom` service folders, and optional API key auth on the
ingest service now exist with a first working cut.

Optional Docker bundle to self-host a **centralized Headroom instance**
(API compression proxy + cache + output shaping) shared across multiple
machines/containers, plus a small **RTK savings aggregation service** —
for teams, as opposed to the "one dev, one machine" usage pattern that
both the official Headroom desktop app and CLI target on their own.

## Companion project

**`easy-headroom`** (logically separate project, under
[`../vscode/`](../vscode/CLAUDE.md)) — the VS Code extension that
installs and configures RTK and/or Headroom per machine, and can point
at this bundle instead of running its own local Headroom proxy
(`easy-headroom.headroom.mode = remote`,
`easy-headroom.headroom.remoteUrl = <this bundle's URL>`). A solo dev
only needs `easy-headroom` (local mode) — this bundle is only relevant
for teams who want a shared Headroom instance.

## Context / why this project exists

RTK (shell output compression, runs locally on each dev's machine) and
Headroom (API compression proxy + cache + output shaping) are two
complementary but independent tools. Headroom's proxy can already be
pointed at from multiple machines (it's just an HTTP proxy), but there
is no ready-to-deploy bundle for teams, and no way to aggregate RTK's
*local-only* savings stats (RTK has no server component, by design —
it can't run remotely without losing its whole point) into one shared
view. This repo fills that gap: a Docker bundle that self-hosts
Headroom plus a small aggregation service, so every dev's RTK savings
roll up into one shared dashboard.

## Architecture: single public entrypoint

Only `easy-headroom` publishes a port (`8787` by default, configurable
via the `EASY_HEADROOM_PORT` env var — see `.env.example` — and used
consistently as both its `PORT` and the published host port in
`docker-compose.yml`). `easy-headroom-proxy` has **no published port**
(`expose: ["8787"]` only, reachable exclusively on the internal Compose
network) — it is not reachable from outside the Docker host at all.

`easy-headroom`'s `server.js`:
- handles `/rtk/*` itself (see below) — the only routes it actually
  implements;
- proxies **everything else** (dashboard, the compressed Anthropic API
  passthrough, WebSocket upgrades, etc.) straight through to
  `http://easy-headroom-proxy:8787` via `http-proxy-middleware`, with
  `ws: true` and an explicit `server.on('upgrade', proxy.upgrade)`
  (Express doesn't forward the `upgrade` event to middleware on its
  own — confirmed against `http-proxy-middleware` v3's docs/behavior).
- Body-parsing (`express.json()`) is scoped to the `/rtk` router only
  — **not** mounted globally — so proxied requests (which may carry
  arbitrary/large Anthropic API payloads) reach `http-proxy-middleware`
  with their body stream untouched instead of already consumed by
  Express.
- Strips `X-Frame-Options` from every proxied response (`onProxyRes`
  hook) — Headroom sends `DENY` on `/dashboard`, which would block
  embedding it in an iframe/webview from a `remote`-mode client, same
  issue already fixed client-side for `local` mode in the VS Code
  extension's dashboard proxy (`commands.ts`).

This means a team only needs to open one port to reach the whole
bundle, and `easy-headroom-proxy` never needs direct network exposure.

## Components

**`headroom` (service)**
- Image based on the official Headroom Dockerfile
  (`headroom-ai[proxy,code]`).
- Contains an `rtk` **wrapper** (a shell script, NOT the real RTK
  binary) mounted at the real binary's path, which:
  - responds to `--version` with a plausible static value,
  - on `gain [...]`, `curl`s `easy-headroom:$EASY_HEADROOM_PORT/rtk/aggregate`
    (same internal Compose network; `EASY_HEADROOM_PORT` is passed into
    this container too — see `docker-compose.yml` — so the wrapper
    always targets the right port even if it's overridden) and returns
    the received JSON as-is,
  - ignores/returns exit code 0 on any other call (no real passthrough
    needed — Headroom only ever calls `gain` in practice, to be
    verified empirically by logging real calls before locking in this
    behavior).
- This wrapper lets Headroom display an aggregated RTK savings `$`
  across all machines, even though RTK is never physically installed
  in this container (RTK must stay co-located with the shell that
  actually runs the commands).

**`easy-headroom` (service, Node.js — the rtk-ingest aggregator + reverse proxy)**
- Compose service name is `easy-headroom` on purpose (this is the
  bundle's public-facing component for the team); routes are
  namespaced under `/rtk/*` so unrelated future routes stay separate,
  everything else is reverse-proxied to `easy-headroom-proxy` — see
  "Architecture: single public entrypoint" above.
- Backed by a SQLite row store (`better-sqlite3`, single controlled
  build target — see "RTK data model" below) at `/data/rtk/aggregate.db`,
  in the same `./headroom_data/rtk:/data/rtk` volume the old JSON
  snapshot store used to live in.
- Receives `POST /rtk/ingest` payloads `{ instance_id, id_project, rows }`
  — raw rows straight from a client's local RTK SQLite `commands` table
  (see "RTK data model"), not `rtk gain`'s pre-aggregated summary. Rows
  are upserted idempotently (`INSERT OR IGNORE`, primary key
  `(instance_id, id)`), so redundant re-pushes (e.g. after a client
  loses its local checkpoint) are a harmless no-op, never double-counted.
- Exposes `GET /rtk/checkpoint?instance_id=...` → `{ last_id }`, the
  server's own max known `id` for that instance — lets a client
  reconcile its local push checkpoint at startup instead of trusting
  a potentially-lost local file.
- Exposes `GET /rtk/aggregate` (optionally `?project=<id_project>`),
  computed live via SQL aggregation over the row store — sums
  `summary` and buckets `daily`/`weekly`/`monthly` series, scoped to
  one project if `?project=` is given, across everything otherwise.
  The old `by_host` field is gone (row-level storage has no host
  concept to key by); a project-scoped view replaces it.
- Exposes `GET /rtk/projects` → `{ projects: [{ id_project, commands,
  input_tokens, output_tokens, saved_tokens, avg_savings_pct }] }` —
  full per-project sums, not just a count, so the RTK dashboard tab's
  "all projects" breakdown table (see `vscode/CLAUDE.md`) doesn't need
  N extra `/rtk/aggregate?project=...` calls to render itself; also
  backs that tab's project picker.
- Protected by a single token, `HEADROOM_PROXY_TOKEN` (passed through
  `docker-compose.yml` via `${HEADROOM_PROXY_TOKEN:-}`), read from
  `.env`. If unset or empty, auth is simply disabled (open access)
  rather than failing startup — a deliberate tradeoff for frictionless
  local/dev use; set a real token before exposing the bundle beyond
  localhost. One token, one header convention (`X-Headroom-Proxy-Token`
  — the same header Headroom's own proxy natively accepts, alongside
  `Authorization: Bearer`), sent by whoever's calling — **`easy-headroom`
  itself never injects this header into proxied traffic, under any
  path, for any caller**:
  - end users calling `/rtk/*` send it as `X-Headroom-Proxy-Token`,
    checked by `easy-headroom` itself (`requireApiKey` in `server.js`);
  - the `rtk` wrapper forwards the same env var as that header when
    calling `/rtk/aggregate`;
  - everything else — the real proxied Anthropic API traffic under
    `/p/<project-slug>/...`, `/dashboard`, static assets, anything
    `easy-headroom` reverse-proxies to `easy-headroom-proxy` — is
    forwarded through **completely untouched** (`server.js`'s
    `onProxyReq` does nothing). Headroom's own security gate on
    `easy-headroom-proxy` checks `X-Headroom-Proxy-Token` directly off
    whatever the original caller sent. Two different callers are
    responsible for sending it themselves:
    - Claude Code, for `/p/...` API traffic: via `ANTHROPIC_CUSTOM_HEADERS`
      (its own extra-header env var), set by
      `ProxyDaemonManager.applyEnvironment` in `vscode/src/daemon.ts`.
    - the VS Code extension's own **local** dashboard proxy
      (`startDashboardProxy` in `vscode/src/commands.ts`) — a small
      `http.Server` on the extension host that the dashboard webview
      talks to, which forwards every request to this bundle and is the
      one place that attaches the header for dashboard traffic, since
      neither a plain browser nor Headroom's own client-rendered
      dashboard JS can be made to set a custom header on themselves.
      A `curl`/browser hitting `/dashboard` on this bundle directly,
      bypassing the extension, is correctly rejected without it — an
      accepted tradeoff, not a bug.

  This design exists because an earlier version had `easy-headroom`
  inject the token as `Authorization: Bearer ${HEADROOM_PROXY_TOKEN}`
  on *every* proxied request, which clobbered the client's own
  `Authorization`/`x-api-key` header carrying their *real* Anthropic
  credentials — breaking actual API traffic while looking like an auth
  rejection. Keeping `easy-headroom` as a pure, header-agnostic
  pass-through avoids that collision entirely; every caller that needs
  the gate token sends it itself. Anyone holding the token is already a
  trusted dev, so a separate internal-only secret would gate no one out.
- Optionally also serves `easy-headroom`'s `.vsix` releases
  (`GET /extension/latest.json` → `{ version, url }`, static files
  under `/extension/`), to reuse existing infra instead of standing up
  a third service.

## RTK data model

RTK itself has no server component and never talks to this bundle
directly — it's a per-machine CLI with its own local SQLite DB
(`~/.local/share/rtk/history.db`, or the platform-equivalent path —
see `rtkHistoryDbPath()` in `vscode/src/paths.ts`), and stays that
way by design. The `easy-headroom` extension (or the standalone
client script below, for machines without it) reads that DB directly
and pushes new rows here incrementally.

**Client identity.** Each RTK install is identified by a random
UUID (`instance_id`), generated once and persisted next to
`history.db` (`.easy-headroom-instance-id`) — not derived from
hostname or hostname+username, both of which collide in practice
(shared hosts, shared host+user, or several workspaces on one machine
that don't all share a DB). See `vscode/src/rtkSyncState.ts`.

**Incremental push, not snapshots.** The client tracks the last `id`
it has successfully pushed in a sibling file
(`.easy-headroom-last-pushed-id`), reads rows past that checkpoint
directly off the SQLite file (safe to read the raw file without
WAL-merging — RTK is a short-lived per-invocation CLI, not a daemon,
so its WAL auto-checkpoints back into the main `.db` file once each
invocation's connection closes; confirmed empirically, no lingering
`-wal`/`-shm` files between commands), and POSTs them to
`/rtk/ingest`. The existing hook — `fs.watch` on `history.db`,
debounced — still triggers each push; only the payload shape and the
read path changed. `GET /rtk/checkpoint` is consulted once at
startup to recover from a lost/reset local checkpoint file, since
that's the one case where the local file could ever be *behind* what
the server already has (ingest is an idempotent upsert, so the
reverse — server behind local — can't happen from a normal push).

**`id_project`.** Sourced from the same `projectSlug()` the VS Code
extension already uses for Headroom's own per-project attribution
(`/p/<slug>` — see `vscode/src/slug.ts`), sent once per ingest batch
rather than per row, so RTK stats can be filtered/grouped by project
the same way Headroom's API proxying already is.

**Schema** (`commands` table in `/data/rtk/aggregate.db`):
`instance_id, id, id_project, timestamp, input_tokens, output_tokens,
saved_tokens, savings_pct, exec_time_ms, project_path`, primary key
`(instance_id, id)`, indexed on `id_project` and `instance_id`.
Deliberately no raw shell command text (`original_cmd`/`rtk_cmd` from
RTK's own table) — only stats leave the client, per
`vscode/CLAUDE.md`'s "never transmit shell command content" rule, the
same boundary `rtk gain`'s own summary output already respected.

**Weekly buckets are approximate.** SQLite has no canonical
ISO-week function; `/rtk/aggregate`'s weekly series groups by
`strftime('%Y-%W', timestamp)` (a Sunday-start week number, not a
true ISO week) and reports `week_start`/`week_end` as the min/max
*observed* command date within that bucket, not the calendar week's
actual boundaries. Fine for a trend view, not for exact
billing-period reporting.

## Expected files

```
docker-easy-headroom/
├── docker-compose.yml
├── .env.example              (HEADROOM_PROXY_TOKEN=change-me)
├── headroom/
│   ├── Dockerfile
│   └── rtk-wrapper.sh         (mounted at /usr/bin/rtk; actual file just named `rtk`)
├── easy-headroom/            (the rtk-ingest aggregator, see Components)
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
└── README.md                  (deployment instructions for the team)
```

## What the README should explain to the end user

1. `cp .env.example .env`, then set a real key.
2. `docker compose up -d --build`.
3. Grab the exposed URL — a single port, `http://<host>:8787`, for
   both Headroom (dashboard, API proxy) and RTK ingestion (`/rtk/*`)
   — and the API key.
4. Give both to every dev on the team for their `easy-headroom`
   extension configuration (`headroom.mode=remote`,
   `headroom.remoteUrl`, `headroom.proxyToken`). RTK stats reporting
   targets `headroom.remoteUrl/rtk/ingest` automatically — there is no
   separate reporting-endpoint setting to configure.

## Client script to document (for machines without the extension)

For machines that don't use the `easy-headroom` extension (CI, other
editors), provide as reference the cron/launchd equivalent of the
extension's live reporting mechanism — same file conventions as
`vscode/src/rtkSyncState.ts` (instance id + checkpoint persisted next
to `history.db`), same incremental row push described in "RTK data
model" above. Requires the `sqlite3` and `jq` CLIs. Don't run this
alongside the extension on the same machine — both would manage the
same checkpoint/instance-id files and race:

```bash
#!/usr/bin/env bash
set -euo pipefail
ENDPOINT="<url>/rtk/ingest"
PROXY_TOKEN="<token>"
ID_PROJECT="<project-slug>"   # match Headroom's own /p/<slug> attribution
DB="$HOME/.local/share/rtk/history.db"   # macOS: ~/Library/Application Support/rtk/history.db
INSTANCE_ID_FILE="$(dirname "$DB")/.easy-headroom-instance-id"
LAST_ID_FILE="$(dirname "$DB")/.easy-headroom-last-pushed-id"

[ -f "$DB" ] || exit 0
[ -f "$INSTANCE_ID_FILE" ] || uuidgen > "$INSTANCE_ID_FILE"
INSTANCE_ID=$(cat "$INSTANCE_ID_FILE")
LAST_ID=$(cat "$LAST_ID_FILE" 2>/dev/null || echo 0)

ROWS=$(sqlite3 -json "$DB" "SELECT id, timestamp, input_tokens, output_tokens, saved_tokens, \
  savings_pct, exec_time_ms, project_path FROM commands \
  WHERE id > $LAST_ID ORDER BY id ASC LIMIT 500")

if [ -z "$ROWS" ] || [ "$ROWS" = "[]" ]; then
  exit 0
fi

curl -sf -X POST "$ENDPOINT" \
  -H "X-Headroom-Proxy-Token: $PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg iid "$INSTANCE_ID" --arg proj "$ID_PROJECT" --argjson rows "$ROWS" \
        '{instance_id: $iid, id_project: $proj, rows: $rows}')"

echo "$ROWS" | jq '[.[].id] | max' > "$LAST_ID_FILE"
```

## Open questions / to verify during implementation

- None yet raised specifically for this bundle beyond what's noted
  above (the `rtk` wrapper's exact call surface, verified empirically
  before locking in behavior).
