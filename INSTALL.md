# Installing

You don't need to clone this repo. The whole bundle is **two files** on
the host you want to run it on:

| File | Where it comes from |
|---|---|
| `docker-compose.yml` | copied as-is from this repo |
| `.env` | your own copy of [`.env.example`](./.env.example) |

Everything else — both Headroom services and the `easy-headroom`
service — is pulled as a published image. Nothing is built locally, and
no other file from this repo is read at runtime.

## Requirements

- Docker Engine with the Compose plugin, **Compose ≥ 2.23.1** (the
  compose file inlines the `rtk` wrapper via `configs: content:`, added
  in that version). Check with `docker compose version`.
- One free TCP port on the host (`8787` by default).

`docker compose up` prints ``WARN[0000] config `uid`, `gid` and `mode`
are not supported, they will be ignored``. It is harmless and expected:
those fields are Swarm-only in Compose's schema, but the `mode: 0555` on
the inlined `rtk` wrapper is applied all the same (verified on Compose
2.26.1). Nothing to do.

## 1. Fetch the two files

```sh
mkdir -p easy-headroom && cd easy-headroom

base=https://raw.githubusercontent.com/studio-vitalyn/easy-headroom-docker/main
curl -fsSLO "$base/docker-compose.yml"
curl -fsSL  "$base/.env.example" -o .env
```

## 2. Fill in `.env`

At minimum, replace the placeholder token:

```sh
sed -i "s/^HEADROOM_PROXY_TOKEN=.*/HEADROOM_PROXY_TOKEN=$(openssl rand -hex 32)/" .env
```

The other variables all have working defaults; the ones you may care
about:

| Variable | Default | What it does |
|---|---|---|
| `HEADROOM_PROXY_TOKEN` | `change-me` | Shared token gating `/rtk/*`, `/tokensave/*` and Headroom's own routes. Leave it **empty** to disable auth entirely (localhost-only setups). |
| `EASY_HEADROOM_PORT` | `8787` | Published host port — the bundle's single public entrypoint. |
| `HEADROOM_IMAGE_TAG` | `latest` | Pin the upstream Headroom image. |
| `EASY_HEADROOM_TAG` | `latest` | Pin the `easy-headroom` image. |
| `TZ` | `Europe/Paris` | Container timezone. |

## 3. Create the state directories

```sh
mkdir -p headroom_data headroom_cache
sudo chown -R 1000:1000 headroom_data headroom_cache
```

This is the usual Compose bind-mount ownership dance: Docker creates a
missing bind-mount source as `root:root`, but the Headroom containers
run as nonroot uid/gid `1000` and would fail to write their state.
Creating the directories yourself with the right owner first avoids it.

`./headroom_data/` and `./headroom_cache/` are where **all** state
lives (Headroom's cache and learned data, plus the RTK/TokenSave
SQLite store under `headroom_data/rtk/`), so keep the directory you ran
this from — it's the only thing worth backing up.

Skip the `chown` if you already run Docker rootless, or if your own
account is uid 1000 — `id -u` tells you.

## 4. Start it

```sh
docker compose pull && docker compose up -d
```

## 5. Check it

```sh
docker compose ps          # three services, easy-headroom-proxy healthy
curl -fsS -H "X-Headroom-Proxy-Token: $(grep ^HEADROOM_PROXY_TOKEN .env | cut -d= -f2)" \
  http://localhost:8787/rtk/aggregate
```

The second command should return JSON (all-zero sums on a fresh
install). A `401` means the token doesn't match; a connection refused
means the stack isn't up.

## 6. Point your machines at it

On each host running the [`easy-headroom` VS Code
extension](https://github.com/studio-vitalyn/easy-headroom-vscode), set:

```
easy-headroom.headroom.mode      = remote
easy-headroom.headroom.remoteUrl = http://<host>:8787
easy-headroom.headroom.proxyToken = <the token from .env>
```

That single URL serves everything: the Headroom dashboard, the
compressed API proxy, and RTK/TokenSave stats ingestion (`/rtk/*`,
`/tokensave/*`) — there is no separate endpoint to configure.

For machines without the extension (CI, other editors), see the
standalone push script in [CLAUDE.md](./CLAUDE.md#client-script-to-document-for-machines-without-the-extension).

## Updating

```sh
docker compose pull && docker compose up -d
```

Same command as the install. To take a new `docker-compose.yml`, re-run
the `curl` from step 1 — your `.env` and `./headroom_data/` are
untouched.

## Customizing

Don't edit `docker-compose.yml`: re-fetching it would wipe your
changes. Put per-host tweaks in a `docker-compose.override.yml` next to
it — Compose merges it automatically, no extra flag:

```yaml
# docker-compose.override.yml
services:
  easy-headroom-proxy:
    environment:
      OPENAI_TARGET_API_URL: https://api.x.ai
```

Anything already parameterised (token, port, image tags, timezone)
belongs in `.env` instead.

## Uninstalling

```sh
docker compose down          # stop, keep data
docker compose down -v       # …and drop the containers' anonymous volumes
rm -rf headroom_data headroom_cache   # drop all state, irreversible
```

## Running from a clone instead

Only useful if you're modifying the `easy-headroom` service itself:

```sh
git clone https://github.com/studio-vitalyn/easy-headroom-docker
cd easy-headroom-docker && cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

See [CLAUDE.md](./CLAUDE.md) for the full design spec.
