# docker-easy-headroom

Docker bundle to self-host a centralized [Headroom](https://github.com/headroomlabs-ai/headroom)
instance plus an RTK savings aggregation service, so multiple hosts can
share one Headroom proxy — and see [RTK](https://github.com/rtk-ai/rtk)
savings from every host rolled up into a single dashboard — instead of
each host running its own local instance.

Companion project: [`easy-headroom`](https://github.com/studio-vitalyn/easy-headroom-vscode) —
the VS Code extension you'd run on each of those hosts day to day. It
can point at this bundle via its `remote` mode instead of spawning a
local Headroom proxy.

## Services

- **`easy-headroom-proxy`** — the Headroom API proxy (compression,
  cache, output shaping). No published port; reachable only on the
  internal Compose network.
- **`easy-headroom-learner`** — Headroom's background learning worker
  (`headroom learn --apply`), sharing the same data/cache volumes as
  the proxy.
- **`easy-headroom`** — the only public entrypoint. Handles `/rtk/*`
  (RTK savings ingestion/aggregation) itself and reverse-proxies
  everything else (dashboard, compressed API traffic) to
  `easy-headroom-proxy`.

## Quick start

1. `cp .env.example .env`, then set a real `HEADROOM_PROXY_TOKEN`
   (e.g. `openssl rand -hex 32`).
2. `docker compose pull && docker compose up -d`.
3. Grab the exposed URL — a single port, `http://<host>:8787` by
   default (`EASY_HEADROOM_PORT` in `.env`), serves both Headroom
   (dashboard, compressed API proxy) and RTK ingestion (`/rtk/*`).
4. Give the URL and token to each host's `easy-headroom`
   extension settings (`headroom.mode=remote`, `headroom.remoteUrl`,
   `headroom.proxyToken`). RTK stats reporting targets
   `headroom.remoteUrl/rtk/ingest` automatically.

## Updating

```sh
docker compose pull && docker compose up -d
```

Nothing is built locally: the two Headroom services run the official
upstream image (`ghcr.io/headroomlabs-ai/headroom`) as-is, and the
`easy-headroom` service is published to
`ghcr.io/studio-vitalyn/easy-headroom`.

Both default to `latest` and both understand the same tag scheme, so
you can pin either one from `.env` if you'd rather not track a moving
tag:

| Tag | Points at |
|---|---|
| `latest` | newest release (the default) |
| `X.Y.Z`, `X.Y` | that specific release |
| `main` | tip of the `main` branch, `easy-headroom` only |
| `sha-<short>` | one exact build |

```sh
# .env
HEADROOM_IMAGE_TAG=0.35-code-nonroot
EASY_HEADROOM_TAG=0.1
```

To rebuild the `easy-headroom` service from source while hacking on it,
`docker compose up -d --build easy-headroom` still works.

## Local tweaks

Don't edit the tracked `docker-compose.yml` — the next `git pull` will
refuse to merge over it. Put per-host changes in a
`docker-compose.override.yml` next to it instead; Compose loads and
merges it automatically, with no extra flag, and it's gitignored:

```yaml
# docker-compose.override.yml
services:
  easy-headroom-proxy:
    environment:
      OPENAI_TARGET_API_URL: https://api.x.ai
```

Anything that's already a variable (token, port, image tags, timezone)
belongs in `.env` rather than an override.

See [CLAUDE.md](./CLAUDE.md) for the full design spec.

## Sponsor

If this project is useful to you, consider [sponsoring on GitHub](https://github.com/sponsors/jaysee).

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE).
