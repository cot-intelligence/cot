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
| Not open source | Free to use, proprietary software |

## Repository

```
cot/
├── website/      # Marketing site (Vite + React)
└── platform/     # Core product (coming soon)
```

### Landing page

```bash
cd website
docker compose up --build
```

Serves at [http://localhost:8081](http://localhost:8081).

## Links

- **GitHub:** [github.com/cot-intelligence/cot](https://github.com/cot-intelligence/cot)
- **Container:** `ghcr.io/cot-intelligence/cot:v1.0`

## License

Cot is free to self-host. Source code is not open source. See repository terms for usage rights.
