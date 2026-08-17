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
`ghcr.io/studio-vitalyn/easy-headroom`. Pin either one from `.env`
(`HEADROOM_IMAGE_TAG`, `EASY_HEADROOM_TAG`) if you'd rather not track
`latest`.

To rebuild the `easy-headroom` service from source while hacking on it,
`docker compose up -d --build easy-headroom` still works.

See [CLAUDE.md](./CLAUDE.md) for the full design spec.

## Sponsor

If this project is useful to you, consider [sponsoring on GitHub](https://github.com/sponsors/jaysee).

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE).
