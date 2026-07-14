# cot

Self-hosted observability for coding agents: the Bridge captures agent activity on the developer's machine and the Collector turns it into Sessions, Events, and Insights served to the dashboard.

## Language

### Ingest

**Event**:
One normalized record of agent activity (a hook firing, tool call, prompt, or response) belonging to a Session.
_Avoid_: trace, log entry, record

**Session**:
One agent working session, identified by the agent's own session id; the unit the dashboard lists and the timeline renders.
_Avoid_: conversation, run (a run is a segment within a session's timeline)

**Origin**:
An Event's provenance — `hook` when delivered live by an agent hook, `import` when recovered from a transcript on disk.
_Avoid_: source (source is the agent: claude, cursor, codex)

**Hook data wins**:
The reconciliation policy for a Session that has both origins: live hook Events supersede previously imported Events, which are purged.

**Ingest Event**:
The canonical, kind-keyed record of one piece of agent activity parsed from a transcript (prompt, response, thought, tool_call, plan, attachment, …) — the same shape regardless of Origin, and the form agent activity takes before it becomes an Event.
_Avoid_: hook payload, synthetic event, artifact (for this shape)

### Storage

**Store**:
The single seam through which Events and Sessions are read from and written to disk. Callers may read with SQL; connection lifecycle, write discipline, and the Event row shape belong to the Store alone.
_Avoid_: database layer, repository, DAL

### Components

**Collector**:
The self-hosted service that ingests Events and serves the dashboard.
_Avoid_: server, backend (as a noun for the component)

**Bridge**:
The on-machine CLI that wires agent hooks, scans transcripts, and posts to the Collector.
_Avoid_: agent (reserved for the coding agents being observed), client
