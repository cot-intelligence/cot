# cot.

**Self-hosted observability for autonomous systems.**

Trace agent reasoning, evaluate outcomes, and ship reliable AI — on your infrastructure. No cloud, no accounts; your traces stay on your machine.

## Quickstart

```bash
curl -fsSL https://cot.run/install | sh
```

This starts the collector in Docker, installs the local bridge, and wires up
hooks for the agents you pick (Claude Code, Cursor, or Codex). Cot runs in the
background and collects traces while you build. Open the dashboard at
[http://localhost:8000](http://localhost:8000).

Already running the collector? Install just the bridge and hooks with
`curl -fsSL http://localhost:8000/install.sh | sh`.

The default port is **8000**. If it is busy, the installer picks the next free
port and saves the URL in `~/.cot/config.json`.

## What you get

- **Full-stack tracing** — LLM calls, tool executions, and custom spans in Python or TypeScript
- **Continuous evaluation** — async evaluators on every trace, flagging regressions
- **Latency monitoring** — token usage and span waterfalls

## Philosophy

| | |
|---|---|
| Self-host only | Runs on your machines, your data stays yours |
| Free forever | No license fees, no metered billing |
| Open source | Licensed under AGPL-3.0 |

## Repository

Collector API, dashboard, bridge scripts, and Docker image — all in this repo.

Marketing site: [cot-intelligence/website](https://github.com/cot-intelligence/website).

### Development

```bash
docker compose up
```

Open [http://localhost:8000](http://localhost:8000) — same port as the install path.

For frontend hot reload on the host instead:

```bash
docker compose run --rm -d --name cot-api -p 8000:8000 api
npm install
COT_API_TARGET=http://localhost:8000 npm run dev
```

Vite serves on [http://localhost:4000](http://localhost:4000) and proxies API calls to the collector on **8000**. Stop the API container with `docker rm -f cot-api` when done.

## Links

- **GitHub:** [github.com/cot-intelligence/cot](https://github.com/cot-intelligence/cot)
- **Container:** `ghcr.io/cot-intelligence/cot:v1.0`

## License

Cot is licensed under [AGPL-3.0](LICENSE).
