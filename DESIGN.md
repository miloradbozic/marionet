# marionet v2 — Design

Marionet's purpose: a daily-driver ops agent for multi-client consulting work — verifiable, repeatable, auditable.
One operator, several clients (each with its own web apps, infrastructure, credentials, conventions), and a small
core that serves all of them without cross-contamination.

This document is the build contract for the v2 roadmap. It distills the architecture review of Jul 2026 (30-run
analysis + comparison against OpenClaw). Keep it current: when a phase lands, update its status here.

## Core thesis: learn once, replay cheap

The v1 run history (30 runs, ~15 turns/run, 53% *self-reported* success) shows a consistent pattern: runs succeeded
in proportion to how much knowledge a human moved out of the model and into artifacts (site playbook, selector
cache, and eventually prompts that were literally step-by-step scripts). v2 makes marionet do that itself:

1. **Explore** — first time a task is seen (including on a system marionet has never touched), run the full agentic
   loop with zero prior knowledge, grounded by accessibility-tree snapshots, under human supervision. Expensive,
   once. The goal is a clean recorded trajectory, not just task completion.
2. **Compile** — distill the successful trajectory (fully captured in `events.jsonl`) into agent-written artifacts:
   a Markdown playbook of the system's quirks and **parameterized skills** with post-condition assertions.
3. **Replay** — subsequent runs execute skills deterministically: no LLM, milliseconds per step, verified by
   assertions.
4. **Self-heal** — when a step fails (site redeploy, redesign), the LLM wakes up for just the broken step:
   re-snapshot, re-discover the element, patch the skill, resume. Skills are shared, so one heal fixes every flow
   that uses the skill.

### Skills, not recordings

The unit of reuse is the **skill**: a named, parameterized step sequence (e.g. `open_product_by_sku(sku)`,
`set_attribute(code, value)`, `save_product()`), not a monolithic end-to-end recording. A new task costs one cheap
planning call ("which known skills cover this?") plus exploration of only the unknown gap. Task literals (SKU,
attribute value) become named parameters: learned on SKU 1123, replayable with SKU 3332.

Skill files are **declarative JSON interpreted by a replay engine** — not generated Playwright code. Rationale:
easier for the LLM to patch during self-heal, easier to audit, and the policy engine can evaluate steps.

### Semantic locators, not CSS selectors

Elements in compiled skills are anchored by their semantic identity from the accessibility tree — role + accessible
name (`getByRole('button', { name: 'Save' })`) — never CSS class names. This systematizes the lesson already in the
v1 Akeneo playbook ("CSS-in-JS class names change on every deploy; prefer text content + visibility").

### Client profiles are learned, not authored

Nothing in the core knows what Akeneo is. Each client gets a `clients/<name>/` directory that **starts empty**;
everything in it (playbooks, skills) is written by marionet as a byproduct of exploration runs. The operator
provides only scaffolding: an env-var namespace (`OPARI_*`, `IH_*`), a kubeconfig context, optional policy
overrides. Runs are invoked as `marionet run --client opari "…"`; the loop loads only that client's knowledge and
credentials, and the audit log records the client context of every action. The Akeneo rules currently hardcoded in
the system prompt get deleted — Akeneo becomes merely the first system marionet learns.

## Borrowed from OpenClaw (and what is not)

Adopt:
- **Accessibility-tree snapshots** — `browser__snapshot` returns a structured text rendering of the page where every
  interactive element has a stable ref; click/fill take refs instead of CSS selectors. Kills the dominant v1 failure
  mode (selector guessing).
- **Docker-sandboxed shell** — per-client containers with mount and egress allowlists replace bare
  bash-with-sudo behind a regex denylist. Policy moves from string-matching to effect containment.
- **Editable-Markdown memory** — per-client playbooks the agent reads *and* writes, version-controlled, reviewable
  with git diff. Replaces the hand-written `sites/*.md` + schemaless `browser-cache.json` split.

Explicitly **not** adopting: gateway daemon, messaging channels, cron/heartbeat proactivity, multi-agent routing,
voice. Those serve "be someone's assistant"; marionet serves "do my client work verifiably". The operator-triggered,
small-core, audit-first model stays.

## Keep from v1 (unchanged)

- CDP-attach to a human-authenticated Chrome; never launch a browser or evade anti-automation.
- `browser__fill_from_env`: secrets resolve in the MCP subprocess; the model only ever names the env var.
- Append-only `events.jsonl` + per-run policy snapshot in `meta.json`.
- Fail-closed policy engine, first-match-wins, deny-all catch-all.
- `finish_task` as the only exit path.

## Roadmap

### Phase 1 — Trust the numbers (`feat/verification`)

Success must be independently verified, and the loop must survive infrastructure flakiness.

- **Verified finish**: `finish_task` with `status: "success"` requires a `verification` object:
  `{ tool, args, expectPattern }` — a read-only tool call the **loop itself executes** after the model calls
  `finish_task`. The run only ends "success" if the tool result matches `expectPattern` (regex). On mismatch the
  loop returns the failure to the model as a tool result and continues (the model can fix the problem or finish
  with `failure`). A `verification` event is logged either way.
- **System prompt**: replace the "do not verify saves / trust the click" efficiency rules with guidance to verify
  via a deterministic read (e.g. re-read the input's value via `browser__eval`), not via toasts or screenshots.
- **LLM resilience**: timeout + retry with exponential backoff (3 attempts on 429/5xx/network errors) around every
  chat-completions call. Logged as `llm_retry` events. (6 of 30 v1 runs died with no status.)
- **Multi-tab**: the browser server tracks the active page as the most recently opened non-closed page instead of
  `context.pages()[0]`, and re-acquires on target-closed.
- **Cost ceiling honesty**: if `maxCostUsd` is set but `pricing` is missing, fail at startup instead of silently
  disabling cost tracking.

Acceptance: unit tests for verified-finish (pass, fail-then-recover) and retry; a task that claims success with a
failing verification does not end the run; `npm run typecheck` and `npm test` green.

### Phase 2 — Accessibility-tree snapshots (`feat/a11y-snapshots`)

- New browser tools: `browser__snapshot` (filtered accessibility tree: interactive + labeled elements only, depth
  and size caps, ref per element) and ref-based `browser__click_ref` / `browser__fill_ref`.
- Refs expire on navigation; the tool result says so and the loop's system prompt instructs re-snapshot after
  page-changing actions.
- CSS-selector tools remain for compiled-flow replay, but the exploration prompt steers to snapshot+refs.

Acceptance: on a local test site (see Testing), the model completes a form task without ever passing a CSS
selector; snapshot output for a large SPA page stays under a fixed token budget.

### Phase 3 — Client profiles + merged Markdown memory (`feat/client-profiles`)

- `clients/<name>/` layout: `playbooks/*.md` (agent-written), `skills/*.json` (Phase 4), `profile.json`
  (env-var prefix, kubeconfig context, policy overrides).
- `--client` flag on `marionet run`; client name recorded in `meta.json` and every event.
- System prompt becomes generic; per-client playbooks are injected as context instead. Akeneo-specific prompt
  rules and `workspace/sites/akeneo.md` migrate into `clients/opari/`.
- Env filtering: MCP subprocesses receive only the client's namespaced vars (plus a small allowlist).

Acceptance: two dummy client profiles cannot read each other's env vars or playbooks; a run without `--client`
still works (default profile).

### Phase 4 — Trajectory compiler (`feat/compiler`)

- Post-run pass (one LLM call over `events.jsonl` of a successful, verified run): segments the trajectory into
  skills, extracts parameters by matching task literals against action args, converts acted-on elements to semantic
  locators, attaches the verification read as the skill's post-condition.
- Skill schema (JSON): `{ name, params, steps: [{ action, locator | expression | command, args, waitFor? }],
  postCondition: { tool, args, expectPattern } }`.
- Compiler also updates the client playbook (Markdown) with system quirks observed during the run.
- Replaces `browser-cache.json` and the `browser__cache_read/write` tools.

Acceptance: compiler unit tests run against real v1 `runs/*/events.jsonl` fixtures; compiling the Jun 30 Akeneo
run yields an `open_product_by_sku` skill with `sku` parameterized.

### Phase 5 — Replay engine + self-heal (`feat/replay`)

- `marionet replay --client opari <skill> --param sku=3332` (and: the agent loop can call a `run_skill` tool).
- Steps execute directly against Playwright; post-condition checked at the end; zero LLM calls on the happy path.
- On step failure: hand the failing step + fresh snapshot to the LLM, get a patched step, resume from that step
  (partial-plan recovery — the fix for the v1 `plan-then-execute` experiment's all-or-nothing failure). The patch
  is written back to the skill file and logged.
- Bulk mode: run a skill over a CSV of parameter rows.

Acceptance: the golden loop test (see Testing) passes; a replay run makes zero LLM calls when nothing is broken.

### Phase 6 — Docker-sandboxed shell + effect-based policy (`feat/sandbox`)

- `shell__exec` runs in a per-client container: client repo mounted, kubeconfig for that client's context only,
  egress allowlist. Bare-metal shell becomes an explicit `ask`-gated escape hatch.
- `browser__eval` moves to the same policy risk class as `browser__submit_form` (it can do everything submit can).
- Required before anything runs unattended against client infrastructure (kubectl, Atlas).

Acceptance: a sandboxed command cannot read another client's mounts or reach a non-allowlisted host; policy tests
cover the new rules.

## Testing strategy

1. **Unit (vitest, exists)** — compiler against real `runs/*/events.jsonl` fixtures; replay engine against a mocked
   browser; verified-finish and retry logic in the loop; policy rules.
2. **Local test site** — a tiny site in `test-site/` served on localhost: static pages plus a small JS-driven form
   that mimics the hard cases already met in the wild (hidden legacy buttons, no native submit, re-rendering
   inputs). Snapshots, ref actions, and replay are tested hermetically against it with real Playwright.
3. **Golden loop (the product thesis as a test)** — on the test site: explore a task once → assert a skill file was
   compiled → replay with different parameters and assert zero LLM calls → mutate the site (rename the button,
   change all class names) → assert self-heal patches the skill and the run still passes its post-condition.
4. **Benchmarks** — ~10 fixed tasks measured per phase: turns, cost, *verified* success rate. v1 baseline: ~15
   turns/run, 53% self-reported success, $0.05–1.50 ceilings.

After local green: `test-opari.cloud.akeneo.com` is the staging environment.

## Config notes

- Per-phase model settings: exploration wants a strong model with vision (`supportsVision: true`); replay uses no
  model; self-heal can use a cheaper one. `run.config.json` grows `models: { explore, heal }` when Phase 5 lands.
- Pricing constants must accompany any `maxCostUsd` ceiling (enforced from Phase 1).

## Deprioritized

OpenClaw-style platform features (daemon, channels, cron, multi-agent, voice); streaming tool dispatch (~3–5s
saving, moot once replay lands); the GUI/desktop MCP server; further prompt-tuning of efficiency rules — they
compensate for the round-trip architecture and trade away verification.
