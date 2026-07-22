# docker-easy-headroom

> **Not started yet.** This repo currently contains only the design
> spec (see [CLAUDE.md](./CLAUDE.md)) — no `docker-compose.yml`, no
> services, nothing to deploy yet.

Docker bundle to self-host a centralized [Headroom](https://github.com/headroomlabs-ai/headroom)
instance plus an RTK savings aggregation service, so a whole team can
share one Headroom proxy — and see everyone's [RTK](https://github.com/rtk-ai/rtk)
savings rolled up into a single dashboard — instead of each dev running
their own local instance.

Companion project: [`easy-headroom`](https://github.com/studio-vitalyn/easy-headroom-vscode) —
the VS Code extension most devs on the team will actually use day to
day. It can point at this bundle via its `remote` mode instead of
spawning a local Headroom proxy.

## Planned quick start

1. `cp .env.example .env`, then set a real `HEADROOM_PROXY_TOKEN`.
2. `docker compose up -d --build`.
3. Grab the exposed URL — a single port, `http://<host>:8787`, serves
   both Headroom (dashboard, compressed API proxy) and RTK ingestion
   (`/rtk/*`) — and the token. `easy-headroom-proxy` itself has no
   published port; `easy-headroom` is the only public entrypoint and
   proxies everything else through to it.
4. Give the URL and token to every dev for their `easy-headroom`
   extension settings (`headroom.mode=remote`, `headroom.remoteUrl`,
   `headroom.proxyToken`). RTK stats reporting targets
   `headroom.remoteUrl/rtk/ingest` automatically.

See [CLAUDE.md](./CLAUDE.md) for the full design spec.

## Sponsor

If this project is useful to you, consider [sponsoring on GitHub](https://github.com/sponsors/jaysee).

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE).
