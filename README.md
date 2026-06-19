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

## What you get

- **Full-stack tracing** — LLM calls, tool executions, and custom spans in Python or TypeScript
- **Continuous evaluation** — async evaluators on every trace, flagging regressions
- **Cost & latency monitoring** — token usage, span waterfalls, budget alerts

## Philosophy

| | |
|---|---|
| Self-host only | Runs on your machines, your data stays yours |
| Free forever | No license fees, no metered billing |
| Open source | Licensed under AGPL-3.0 |

## Repository

```
cot/
└── platform/     # Collector API, dashboard, and Docker image
```

Marketing site lives in [cot-intelligence/website](https://github.com/cot-intelligence/website).

### Development

```bash
cd platform
docker compose up
```

- Dashboard (Vite HMR): [http://localhost:4000](http://localhost:4000)
- Collector API: [http://localhost:8000](http://localhost:8000)

## Links

- **GitHub:** [github.com/cot-intelligence/cot](https://github.com/cot-intelligence/cot)
- **Container:** `ghcr.io/cot-intelligence/cot:v1.0`

## License

Cot is licensed under [AGPL-3.0](LICENSE).
