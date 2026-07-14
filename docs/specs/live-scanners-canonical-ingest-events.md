# Route the Bridge's live scanners through the canonical Ingest Event seam

Status: implemented; replay validation pending

## Problem Statement

The Bridge captures agent activity twice over: live, when hooks fire during a Session, and by import, when transcripts are recovered from disk. The two paths encode "how a transcript becomes Events" independently. As a user, the same transcript produces materially different Sessions depending on Origin: imported Cursor plan-mode Sessions render blank where live ones show a structured plan; live Cursor Sessions are missing the agent's thoughts that import recovers; repeated commentary blocks are collapsed live but spam imported timelines; and token usage is accounted differently per path. As a maintainer, every transcript-format change and every payload bug must be found and fixed twice — two shipped bugs (dropped assistant responses, duplicated Cursor responses) lived exactly in this duplication, and the live path has no tests because scanning, payload mapping, and posting are fused into single functions.

## Solution

The import path already owns a deep seam: per-agent parsers emit canonical Ingest Events (kind-keyed records — prompt, response, thought, tool_call, attachment, session_metadata), and a single adapter maps them onto the Collector's wire format. This change routes the live path through that same seam. Live scanners return canonical Ingest Events from the same shared per-agent line-parsers that import uses; a thin per-agent live shell handles only what is genuinely trigger-context behaviour (when to scan, pairing recovered question answers, the suppress-default-post protocol). The canonical vocabulary grows to absorb Cursor's specials: a `plan` kind and an `interruption` marker. One parser per agent, one adapter, both Origins — a payload fix lands once and covers live and import alike, and the live path becomes testable exactly the way the import path already is.

## User Stories

1. As a developer observing my agent sessions, I want a Cursor Session to look the same whether it was captured live or imported from a transcript, so that the dashboard tells one truthful story per Session.
2. As a developer observing my agent sessions, I want imported Cursor plan-mode Sessions to show the structured plan (name, overview, body, todos), so that plan turns no longer render blank in imported history.
3. As a developer observing my agent sessions, I want live Cursor Sessions to include the agent's thoughts, so that live capture is not poorer than import for the same transcript.
4. As a developer observing my agent sessions, I want repeated identical commentary blocks collapsed in imported Sessions the same way they are live, so that imported Cursor timelines are not padded with dozens of duplicate Events.
5. As a developer observing my agent sessions, I want token usage totals preserved when live scanning drops Events that hooks already delivered, so that cost tracking does not silently undercount.
6. As a developer observing my agent sessions, I want a user-interruption to flag the Event it cut off in both Origins' data, so that interrupted turns are identifiable in the timeline.
7. As a developer whose Bridge crashes or loses its offset state, I want re-scanned transcripts to be recognized as already ingested, so that recovery never duplicates my Session history.
8. As a developer whose agent double-fires a hook, I want scanner-recovered Events deduplicated by stable keys rather than a five-second window, so that slow retries cannot create duplicate Events.
9. As a developer with an imported Session that later goes live, I want live Events reconciled by the hook-data-wins policy rather than swallowed as duplicates of imported rows, so that resuming an imported Session works correctly.
10. As a developer using Cursor's AskQuestion flow, I want the question and its recovered answer captured as one coherent Event pairing in both Origins, so that clarification exchanges are visible in every Session.
11. As a maintainer, I want the transcript shape of each agent known to exactly one parser, so that a format change is a one-module edit regardless of Origin.
12. As a maintainer, I want the Collector wire format known only to the single adapter, so that payload bugs concentrate in one place and a fix covers both Origins.
13. As a maintainer, I want the live shells reduced to trigger-context orchestration, so that reading a shell tells me when scanning happens, not how payloads are built.
14. As a maintainer, I want the live path covered by tests at the same seams as the import path, so that the previously untested half of the Bridge stops being where bugs ship.
15. As a maintainer, I want golden-master recordings of today's live behaviour frozen before the refactor, so that unwritten behaviours (plan-only-turn fallback, safety-net final text) cannot be silently lost.
16. As a maintainer, I want a replay diff of the new path against my real transcripts and the raw ingest ledger before merge, so that every behaviour change is either on the expected-differences list or treated as a bug.
17. As a maintainer, I want Claude and Codex unified and gated before Cursor, so that the riskiest agent cannot stall the proven wins.
18. As a maintainer, I want a documented fallback for Cursor (bespoke scanner still emitting canonical Ingest Events), so that a noisy replay diff has a pre-agreed exit that preserves the vocabulary win.
19. As a future agent-source implementer, I want adding a new agent to mean writing one line-parser that emits canonical Ingest Events, so that both live and import capture come for free.
20. As an AI coding agent working on this repo, I want the Ingest Event vocabulary defined in the domain glossary and the seam recorded in an ADR, so that I can navigate to the right module without reverse-engineering two pipelines.
21. As a dashboard user, I want Cursor question turns to appear as a single instant tool Event rather than a synthetic start/end pair, so that question turns read as one item without a fake duration.
22. As a maintainer of the drift ledger, I want live and import to project through the same mapping, so that drift metrics measure agent behaviour rather than pipeline divergence.

## Implementation Decisions

- **Scope: all three agents** (Claude, Codex, Cursor). The unification is void without Cursor; its differences are handled by design, not exclusion.
- **The live scanner interface is a list of canonical Ingest Events** — the same type the import parsers return. No sidecar return values: everything the live path needs beyond the events is derivable from the event list plus the hook body the shell already holds.
- **One shared line-parser per agent**, used by both Origins. Live shells become: read transcript delta → feed lines through the shared parser → apply generic post-steps → adapt → post.
- **Four generic post-steps**, each a pure transformation on the event list, written once and shared across agents:
  1. Per-agent kind filter — drop Events the agent's hook surface already delivers live — with usage folding, so tokens on dropped Events land on the next kept Event and totals are preserved.
  2. Timestamp rewrite — Cursor live Events take the hook timestamp plus ordering offsets instead of the import path's mtime synthesis.
  3. Interruption flagging — the parser emits a canonical `interruption` marker Event; the shared post-step flags the preceding Event in both Origins and then removes the marker before adaptation.
  4. Consecutive-identical response collapse — applied to both Origins, so imported Cursor Sessions get the same cleanup live ones do.
- **Vocabulary additions:** a `plan` kind carrying name, overview, body, and todos, mapped by the adapter onto the plan wire shape the Collector's normalize layer already accepts; questions become a single instant tool_call (adopting the import parser's documented choice), retiring the live path's synthetic pre/post pair.
- **Trigger-context behaviour stays in thin per-agent live shells:** which hooks trigger a scan; pairing the hook body's text to recovered question Events and posting answers to the dedicated answer endpoint; the suppress-default-post signal (derived from whether the scan yielded response or plan Events); the safety-net append of the hook's final text; Codex's fallback to the last assistant message when no transcript is readable.
- **Dedup: live scanner Events carry explicit, origin-namespaced dedup keys** (Claude: uuid-derived; Cursor: absolute byte offset plus block index). Namespacing guarantees no collision with import keys, so hook-data-wins reconciliation is untouched, while re-scans and hook retries become idempotent under the Collector's existing explicit-key dedup regime. Non-scanner hook payloads keep the existing five-second window behaviour.
- **Zero Collector changes.** The adapter still emits hook-style payloads; the plan wire shape and the explicit-dedup semantics already exist server-side.
- **Sequencing: two replay-gated changes.** Change one: seam infrastructure, post-steps, and the Claude and Codex live shells. Change two: Cursor (plan kind, instant questions, shared collapse, answer pairing in the shell). If Cursor's replay diff is noisy, change two falls back to a bespoke Cursor scanner that still emits canonical Ingest Events — vocabulary and adapter unification survive even in the fallback.
- **Side effects:** add "Ingest Event" to the domain glossary; record an ADR ("live scanners emit canonical Ingest Events; trigger-context behaviour stays in live shells") so future architecture passes don't re-litigate the shells' existence or re-specialize the scanners.

## Testing Decisions

- **Good tests here exercise external behaviour at a seam:** transcript content in, canonical Ingest Events or posted payloads out. No test reaches past an interface to assert on parser internals, offset state, or intermediate shapes.
- **Two test seams, both already existing in the code:**
  1. **The canonical Ingest Event seam** — transcript lines in, canonical Events out. Covers the shared parsers (plan kind, instant questions, interruption marker, dedup key minting) and the pure post-steps (list in, list out). Prior art: the import path's canonical contract tests, which already test the parsers this way.
  2. **The posting seam** — the Bridge's single exit. Tests intercept the post function and assert ordered (endpoint, payload) sequences from a hook body plus a transcript fixture. Covers live-shell orchestration: suppress-default protocol, answer pairing, safety-net text, Codex's no-transcript fallback.
- **Golden masters recorded before any refactor:** today's live emit behaviour captured at the posting seam over fixtures covering Cursor's four hard turns — a plan turn, a question turn with and without a recoverable answer, the repeated-commentary pathology, and a plan-only turn with no text. After the refactor the same fixtures must reproduce the recordings modulo the expected-differences list; the goldens then graduate into the live path's permanent suite.
- **Merge gate: replay diff against real data** — the developer's actual transcripts and the raw ingest ledger's recorded payloads as the oracle. Every diff must appear on the expected-differences list or be treated as a regression.
- **Expected-differences list (seed):** Cursor live gains thought Events; Codex live gains standalone reasoning-summary thought Events already recovered by import; question pre/post pairs become single instant Events; live Events gain dedup keys; Claude usage placement shifts from pending-fold to per-block with folding on filtered Events (totals preserved); imported Cursor Sessions gain plan Events and lose consecutive duplicate responses; imported Claude and Cursor output immediately followed by an interruption marker gains `interrupted: true` (Codex import already carried this signal); imported Claude Sessions recover standalone file-attachment records that match their parent prompt.
- **Final confidence pass:** one live smoke Session per agent against a dev Collector, eyeballing the timeline beside an equivalent old-path Session.

## Out of Scope

- Any Collector-side changes: wire format, normalize layer, dedup regimes, the hook-data-wins policy, and the Store seam are all untouched.
- Removing the Collector-side Cursor transcript scan (the question-recovery backfill that duplicates Bridge knowledge). It is a separate deepening candidate; this change may make it redundant, but verifying and deleting it is its own piece of work.
- Typing the Store's read queries (settled by the existing ADR) and any category-vocabulary registry work.
- The Bridge's hook wiring, install, backup, and docker lifecycle concepts — untested today, but not part of this seam.
- Changing what the dashboard renders beyond what falls out of unified Event streams.
- Migrating or rewriting historical Sessions already in the Store; only re-imports and new captures flow through the unified path.

## Further Notes

- The riskiest behaviour cluster is Cursor's live shell (plan-only fallback, answer pairing, suppress-default). The design isolates it precisely so the fallback can amputate Cursor's parser sharing without losing the vocabulary and adapter unification.
- The interruption marker and the plan kind slightly widen the canonical vocabulary; both are consumed Bridge-side (marker) or already understood Collector-side (plan), so the wire format's surface does not grow.
- Import automatically gains plan Events by virtue of the shared parser — flagged during design as closing a drift bug, not scope creep; the replay diff quantifies exactly what it changes in existing history.
