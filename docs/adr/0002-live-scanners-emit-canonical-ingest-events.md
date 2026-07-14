# Live scanners emit canonical Ingest Events; trigger-context behaviour stays in live shells

Status: accepted

The Bridge captures transcripts on two paths — live (hook-triggered delta scans) and import — and they used to encode "transcript → Collector payload" independently, which is where both shipped scanner bugs lived. We decided both Origins share one line-parser per agent, emitting canonical Ingest Events, adapted to the wire format in exactly one place. The live path's genuine differences are handled by design, not by a second parser: generic post-steps on the event list (kind filtering with usage folding, timestamp rewrite, interruption flagging, consecutive-response collapse), plus a thin per-agent live shell for what only the trigger context knows (when to scan, pairing recovered question answers, the suppress-default-post signal, safety-net final text).

## Considered Options

- **Separate live scanners that merely return canonical events** — rejected: keeps two parsers per agent, preserving the exact duplication that produced the dropped-response and duplicated-response bugs.
- **Events + sidecar return shape for live extras** — rejected: every sidecar fact (plan-turn flag, questions) is derivable from the event list plus the hook body the shell already holds; a sidecar is a second copy with one authority available.
- **Question turns as synthetic pre/post pairs (old live behaviour)** — rejected in favour of the import parser's single instant tool_call; Cursor transcripts carry no tool results, so the pair was two rows rendering as one item.

## Consequences

- Live shells must not grow parsing or payload knowledge; if a shell needs a new fact from the transcript, the shared parser emits it as an Ingest Event (or marker kind, like `interruption`) instead.
- Live scanner Events carry origin-namespaced explicit dedup keys, making re-scans idempotent without colliding with import keys or disturbing hook-data-wins reconciliation.
- Agreed fallback if Cursor's replay diff proves noisy: Cursor keeps a bespoke scanner that still emits canonical Ingest Events — parser sharing is sacrificed, the vocabulary and single adapter are not.
