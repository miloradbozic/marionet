# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run marionet -- run "<task>"                 # run the agent (default profile: full env, no playbooks)
npm run marionet -- run --client opari "<task>"  # client run: their playbooks injected, env filtered to their vars
npm run marionet -- last           # one-glance stats for the latest run: duration, cost, LLM turns, replay-or-not
npm run marionet -- transcript     # render latest run to markdown (useful if run was killed)
npm run marionet -- transcript <run-id>
npm run marionet -- compile [run-id]             # compile a successful+verified run into reusable skills
npm run marionet -- compile [run-id] --heuristic # ...skip the LLM segmentation call (offline, monolithic)
npm run marionet -- replay --client opari set_product_ean --param product_id=2002 --param ean=999   # zero-LLM replay
npm run marionet -- replay --client opari set_product_ean --csv rows.csv   # bulk: one replay per CSV row
npm run marionet -- skills --client opari        # list the client's compiled skill library

npm run typecheck                  # type-check orchestrator + both MCP workspaces
npm test                           # vitest unit tests (orchestrator only; no browser/shell)
```

Before any browser task, start Chrome with the debug port in a separate terminal:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/marionet-chrome
```

## Architecture

Marionet is a thin agentic loop around an OpenAI-compatible LLM API (`src/llm-client.ts` routes by model prefix to OpenRouter, DeepSeek, or Anthropic direct; currently configured in `config/run.config.json` for Qwen3-VL-235B-A22B via OpenRouter). It gives the model shell, filesystem, and browser access via MCP servers, then controls what it's allowed to do through a policy engine.

```
cli.ts
 ├── McpClientManager   – spawns MCP servers as stdio subprocesses, routes tool calls
 ├── PolicyEngine       – evaluates every tool call before execution; fail-closed
 ├── runAgentLoop       – the core loop: call API → handle tool calls → repeat
 └── RunLogger          – append-only events.jsonl + meta.json per run
```

### Agent loop (`src/loop/agent-loop.ts`)

One iteration = one LLM API call. The loop handles three cases per response:
- **Tool calls** → evaluate each against policy, execute via MCP, feed results back
- **No tool calls** → inject a nudge message and continue (up to `maxTurns + nudges` total)
- **`finish_task` call** → return immediately with status/summary

`finish_task` is the only exit path. The loop never exits on a text-only response. `process.exit()` is called explicitly in `cli.ts` after MCP teardown because the browser server holds an open CDP WebSocket that would otherwise keep Node alive.

### Policy engine (`src/policy/`)

`config/policy.json5` is evaluated top-to-bottom, first-match-wins, with a deny-all catch-all at the end. Rules match on tool name (glob) and optionally on args (regex per field). The policy is snapshotted into `meta.json` at run start so past gating decisions stay auditable even after the file changes.

Actions: `allow` (run unattended) | `ask` (pause for human y/n/a) | `deny` (return error to model).

The `a` (always-allow) choice is in-memory only for the current run — it never writes back to `policy.json5`.

### MCP servers

Both servers are in `mcp-servers/` and are separate npm workspaces (`mcp-servers/core`, `mcp-servers/browser`). They're spawned by `McpClientManager` with the full `process.env` forwarded (so `.env` vars are available inside tools, including `browser__fill_from_env`).

**core** (`mcp-servers/core/src/server.ts`): `shell__exec`, `fs__read`, `fs__write`, `fs__list`. Shell commands run in `workspace/` by default.

**browser** (`mcp-servers/browser/src/server.ts`): Attaches to an already-running Chrome over CDP (`MARIONET_BROWSER_CDP_ENDPOINT`, default `http://localhost:9222`). Never launches its own browser. Key tools:
- `browser__snapshot` — filtered accessibility-style view of the page: every visible interactive element with role, accessible name, state, and a ref (`e1`, `e2`, ...). The preferred perception tool; refs expire on navigation/re-render (implementation: `snapshot.ts`, tags elements with `data-marionet-ref`).
- `browser__enumerate` — lists every element matching a CSS selector, in document order, returning chosen DOM `attributes` (data-*, class, ...) and/or trimmed `text` per element as a JSON array. Reads *structure* of a repeated region in one call (grid rows, list items) — and unlike `snapshot` it can read arbitrary attributes, not just interactive elements. This is the "scan the schema" primitive: enumerating `tr[data-attribute]` on an Akeneo product page yields the full set of attribute codes in one call. Note: `text` is `textContent`, which excludes `<input>` values (so it gives clean field *labels*, not field values — read a value with `browser__extract` `format: "value"`). Logic is in `enumerate.ts`, unit-tested in `test/enumerate.test.ts`. A generated per-client catalog (`clients/<client>/playbooks/attribute-catalog.md`) maps prose attribute names → codes so `read_attribute`/`write_attribute` skills get the right `attribute_code`.
- `browser__extract` — reads page content: `format: "text"` (visible text), `"html"` (narrow selectors only), `"value"` (an input/textarea/select's current value), `"screenshot"`. **`"value"` is the verification primitive**: `innerText` excludes input values, which is why every post-condition used to reach for `browser__eval`. Because extract is read-only by construction it stays `allow` on clients that gate `eval` to `ask` for prompt-injection reasons (job-apply) — so a skill compiled today replays unattended where an eval-verified one would stall on a human prompt. The loop, `finish_task`, and the segmenter prompts all steer to it; `eval` remains for reads extract can't express (e.g. `location.hash`) and for skills compiled before it existed. Verified live against `test-site` (value read matches the eval read it replaces; missing selector errors in ~6s, not 30s) and end-to-end through the golden loop, whose scripted run now verifies via extract.
- `browser__click_ref` / `browser__fill_ref` — act on snapshot refs instead of guessed CSS selectors. `browser__fill_from_env` also accepts a `ref`.
- `browser__fill_from_env` — fills an input from a named env var; the secret value never reaches the model. Use this instead of `browser__fill` for passwords/API keys.
- `browser__submit_form` — finds `[type=submit]` within the given selector and clicks it. Works for standard HTML forms; does **not** work for JS-driven forms with no native submit button, or submit buttons outside the `<form>` tag (use `browser__click` directly in those cases). If broadening: consider an explicit `submitSelector` param.
- `browser__press` — presses a keyboard key (e.g. `Enter`), optionally after focusing a selector. Needed because `browser__fill` sets a value and fires only an `input` event — it sends no keystrokes, so debounced or Enter-to-submit search boxes (e.g. the Akeneo product grid) never fire on fill alone.

- `browser__click_text` — clicks the element whose visible text matches a string (substring or exact). If the match is inside a `<tr>` it clicks the whole row (data grids open on row click); else the nearest `<a>`/`<button>`; else the element. Reports whether the page navigated. Exists so the model stops hand-writing fragile `browser__eval` row-clicks (which repeatedly paraphrased into broken variants that no-oped and falsely reported success). Raw-string `page.evaluate` to dodge the esbuild `__name` hazard.
- `browser__select_record` — sets a type-ahead / autocomplete select widget (search input → filtered dropdown → click an option), the kind that is **not** a native `<select>` so `browser__select` can't touch it (Akeneo simple-select and reference-entity attributes: placeholder "Click here to select a record"). Does the whole interaction atomically server-side — Escape any stray dropdown, focus + clear the input, type `searchText`, wait for `optionSelector`, click it, Escape — because splitting it into separate click/fill/click replay steps is flaky (the widget's open/close and search-debounce state leaks between calls). Powers the `set_select_attribute` skill (`[data-testid='<option_code>']` is the option). Proven live via zero-LLM replay setting a color attribute and restoring it.
- `browser__scroll` — scrolls a ref/selector into view, or the whole window by a pixel offset. Exists because some SPAs virtualize/lazy-mount long lists (e.g. Akeneo's product attribute groups): a section's fields are absent from the DOM entirely — not just visually hidden — until scrolled into view, so no amount of `wait_for` or `snapshot` querying finds them first.
- `browser__scroll_until_visible` — loops scroll-by-amount + existence-check server-side (default 800px/attempt, 15 attempts) until a selector matches, in one tool call. Exists so a compiled skill can find virtualized content by target selector alone (e.g. `tr[data-attribute='{{attribute_code}}']`) instead of baking in a fixed pixel-scroll sequence recorded from one run against one page layout — the thing that makes a skill reusable across parameters rather than overfit to the run it was compiled from.
- `browser__reveal` — like `scroll_until_visible`, but for content behind a *collapsed/accordion section* rather than just below the fold: tries each element matching `sectionSelector` in turn (click to expand, then scroll) until `targetSelector` matches. Akeneo's product attribute groups are exactly this — a `tr.attribute_group_row` header must be clicked before its fields mount at all, no amount of scrolling reveals a collapsed section. Lets one skill (`scroll_to_attribute(attribute_code)`) work for any attribute in any group, instead of one hardcoded skill per attribute (`scroll_to_ean_attribute`, `scroll_to_sku_attribute`, ...).

**Fill/reveal take the first match, not a unique one.** `browser__fill`'s `selector` path and `browser__reveal`'s locators use `.first()` rather than requiring exactly one match — some rows legitimately contain more than one `<input>` (e.g. an Akeneo measurement attribute's value + unit fields both under the same `tr[data-attribute=X]`), and the read side (`document.querySelector`) already silently takes the first match, so fill/reveal now agree with it instead of hard-erroring on "strict mode violation: resolved to 2 elements."

**Auto-settle.** Every mutating browser tool (`navigate`, `click`, `click_ref`, `fill`, `fill_ref`, `fill_from_env`, `press`, `select`, `submit_form`, `eval`, `scroll`, `scroll_until_visible`, `reveal`) calls `settle(page)` before returning: it resolves once the DOM has been quiet for ~500ms (or after a 4s cap). This bakes a human-like "wait for the page to stop changing, then look" beat into every action, so the model can't act on or perceive a half-rendered SPA (the root cause of stale-row / "0 results" misreads on Akeneo). It's adaptive — near-instant on a static page, longer only while the page is actually re-rendering. Implemented as a raw-string `page.evaluate` to dodge the same esbuild `__name` hazard documented in `snapshot.ts`.

### Trajectory compiler (`src/compiler/`)

Turns a successful, verified run into reusable **skills** — the "learn once, replay cheap" half of the roadmap (Phase 4). `marionet compile <run-id>` reads that run's `events.jsonl` + `meta.json` and emits one `clients/<client>/skills/<name>.json` per segment plus a composed **flow** skill that chains them.

Pipeline (`compileRun` in `compile.ts`):
1. `assertCompilable` — refuse unless `meta.status === "success"`, `finish_task` was `success`, and a `verification` event matched. A skill you can't trust is worse than none.
2. `extractTrajectory` (`trajectory.ts`) — reduce events to the executed, non-errored tool calls (steps, each carrying its recorded result text) and lift the passing verification into a `postCondition`. A ` [target: role "name"]` suffix in a result becomes the step's semantic `locator` (browser tools report the acted element's ARIA role + accessible name; see `identity.ts`). Drops a trailing step that merely re-reads the post-condition value.
3. `detectLiterals` (`parameterize.ts`) — find task tokens that also appear in the step args, restricted to *value-like* literals (quoted strings, or tokens containing a digit). Prose words like `EAN`/`Akeneo` are deliberately skipped: they appear in a search-box value but not in the lowercased/snake_cased selector, so parameterizing them yields a half-substituted, broken skill.
4. `segmenter` (`segment.ts`) — one LLM call proposes segment boundaries, snake_case names, per-segment read-only post-conditions (must hold for *any* params — no run-specific UUIDs), param names, and playbook notes. `validateSegmentation` is the trust boundary: contiguous partition, paramNames ⊆ detected literals, read-only post-condition tools only. Any violation discards the whole proposal for the deterministic `monolithSegmenter` (also used by `--heuristic`).
5. `parameterize` — replace every literal occurrence with `{{param}}` across steps (args **and** locator names) + post-conditions. Substitution is driven by the detected literals, never by the segmenter's keys.

Segment post-conditions: every segment except the last needs a synthesized structural check (e.g. "the attribute search box exists"); the last segment inherits the run's verified post-condition. `emit.ts` writes the skill files and appends deduped playbook notes to `clients/<client>/playbooks/learned.md`.

**Anchor stability** (`stability.ts`, REINVENTION P3): every semantic locator is scored at compile time from the shape of its accessible name + role, and the verdict is stamped onto the locator (absent = `stable`, so good anchors stay terse). Grounded in how `identity.ts` actually builds names, not taste: `nameOf` prefers an *authored* label (aria-label, `<label>`, placeholder, title) and only falls back to `textContent`, **truncated at 80 chars with a literal `"..."`** — so a name ending in `...` is proof the anchor is a container's concatenated descendant text with its tail cut off. `roleOf` maps `<tr>` → `row`; a container role has no label of its own, so its name is whatever its cells render today. On top of that, volatile content (percentages, dates, times, unparameterized digit runs) scores `fragile`.

This catches a failure P1 misses: an anchor mentioning no CSS class still rots if it carries a completeness % or an "updated" timestamp — not on a redeploy, but **because you used the record**. `marionet compile` reports fragile/weak anchors at birth; `marionet skills` scores *on read*, so skills compiled before the scorer existed get audited too (this is what found `open_product_detail_page`'s row anchor in the opari library). Replay inverts its attempt order for a fragile anchor — semantic-first is justified by role+name outliving CSS churn, which a fragile anchor does not, so the recorded selector goes first instead of paying a guaranteed failed attempt.

**Lineage** (`lineage: LineageEntry[]` on every skill): compile stamps an `explored` root; every heal appends a typed `heal` entry naming the step, its new target, and the run that patched it. The skill JSON records *state*; the lineage records *becoming* — without it, a skill that's been healed twice and hand-patched once can't answer "which of these hands broke it?". `marionet skills` renders the chain. At `REEXPLORE_HEAL_THRESHOLD` (3) heals the replay logs a `reexplore_proposed` event and says so in its summary: the site has drifted enough that re-learning beats patching. It is advisory — re-exploration spends a strong model and wants a human who chose it.

Skills live under the client (gitignored, like other client data); the committed proof is `test/compiler.test.ts` running against the real `test/fixtures/akeneo-set-ean.events.jsonl`.

### Replay engine (`src/replay/`)

Executes a compiled skill deterministically — **zero LLM calls on the happy path** (Phase 5). `marionet replay [--client x] <skill> --param k=v` resolves the skill (flows expand into primitives with scoped params, cycle-guarded), substitutes params fail-closed (an unresolved `{{placeholder}}` aborts; values substituted into `expectPattern` are regex-escaped), and runs each step through the same `PolicyEngine` gate and `RunLogger` as exploration — a replayed action is no less real than a model-proposed one.

- **Semantic-first targeting**: steps with a `locator` try `browser__click`/`browser__fill` with `role`+`name` first; the recorded CSS selector is the second chance, not the primary anchor.
- **Post-conditions**: each primitive ends with its read-back check; a mismatch fails the replay (never healed — the engine can't know which earlier step lied).
- **Self-heal** (`heal.ts`): when a step fails both attempts, one LLM call gets the parameterized step template + error + fresh snapshot and returns a patched step (validated by `validatePatch`, policy-gated at execution). Budget: 3 heals *attempted* per replay (the ceiling bounds LLM spend, and a heal costs its call whether or not it earns promotion); `--no-heal` disables; `models.heal` in run.config overrides the heal model.
- **A patch is a proposal, not a fix** (REINVENTION P22): a patch whose step *executes* is held pending, and only written to the skill file once that primitive's **post-condition passes** — then one heal fixes every flow composing the skill. If the post-condition fails, every pending patch is discarded and logged as `heal_discarded` with both versions. This is what stops a dead session from corrupting the library: on a login wall the healer happily re-grounds "click Save" onto a button that really is on the page, the click succeeds, and a promote-on-step-success rule would write that into the skill permanently — even though the read-back proves the row did nothing.
- **Bulk** (`batch.ts`): `--csv rows.csv` (header = param names) replays once per row and continues on failure — a bad SKU is row-local and says nothing about the next row. But a **run** of failures is a different animal: the session expired, the site changed, the app is down, and every remaining row will fail identically. So the batch trips a breaker after 3 *consecutive* failures (any success resets the count, so a scatter of bad rows never trips it) and reports how many were left untried. Without it, a session that dies at row 214 of 300 burns 86 more full replays, each waking the healer against a login wall.
- **Warm-up prefix** (`warmUpSkill` / `readOnlyPrefix`): before a `--csv` batch, the skill's leading run of read-only steps (navigate/extract/snapshot/wait/scroll — a fail-closed allowlist; `click`, `reveal`, and `eval` are excluded because a click is a save as often as a tab switch) executes once against the first row. It exercises exactly what breaks between batches — the session died, the page was redesigned — and a failure aborts the batch with **nothing written**, instead of discovering the redesign at row 117 of 300. Deliberately not a scheduled sentinel: no 3am probes against client systems, it's part of the imminent run and costs one page load. Single-row replays skip it (the row is its own warm-up).
- **run_skill**: when the client's skill library is non-empty, the exploration agent gets a `run_skill` tool that executes skills through this engine — known-good flows in one call instead of step-by-step rediscovery.

The **golden loop test** (`test/golden-loop.test.ts`, needs installed Chrome; ~35s) proves the whole thesis hermetically against `test-site/app.html`: explore → compile → replay (0 LLM calls) → mutate the site (`app.v2.html`) → self-heal → replay clean again.

### Logging (`runs/<run-id>/`)

- `events.jsonl` — append-only source of truth; survives crashes
- `meta.json` — run metadata + policy snapshot at run time
- `transcript.md` — rendered markdown summary (written on clean exit; use `marionet transcript` to render from events if the run was killed)

### Credential handling

Secrets go in `.env` (gitignored). `tsx --env-file=.env` loads them into the Node process; `McpClientManager` forwards `process.env` to MCP subprocesses so `browser__fill_from_env` can read them. The pattern: the model specifies the **env var name**, not the value — so secrets never appear in the LLM conversation.

## Prompting tips

**SPAs: direct to nav clicks, not URLs.** SPAs (React, Angular, Akeneo, Salesforce, etc.) use hash or API-driven routing where URLs are hard to predict. If a prompt says "navigate to the Products page", the model will guess a URL, get a 404, and recover via the sidebar anyway — wasting turns. Say "click the Products link in the left sidebar" instead. General rule: for any SPA, tell the agent *where to click*, not *where to go*.

## Extending

**Add a new tool**: register it in the relevant MCP server (`server.registerTool(...)`), then add a policy rule for it in `config/policy.json5` (it will be denied by default).

**Add a new MCP server**: add it to `config/run.config.json` under `mcpServers`. It will be spawned as a stdio subprocess and its tools auto-registered.

**Change the model or ceilings**: edit `config/run.config.json` (`model`, `maxTurns`, `maxCostUsd`, `maxTokens`). Cost estimation reads the `pricing` field from that same config (via `estimateCostUsd` in `src/llm-client.ts`) and needs manual updates if the model changes.

## Future directions

These were identified through experimentation but not yet implemented on main. Branches `experiment/faster-browser-loop` (Haiku + no-verify prompt) and `experiment/plan-then-execute` (`plan_steps` tool) exist for reference.

**Extended thinking + upfront page snapshot.** The core bottleneck is the perceive-decide-act cycle: every observation costs a full API round trip. The hypothesis is to give the model a rich initial snapshot (full DOM, accessibility tree, or screenshot) at the start of a flow, let it reason through the entire sequence in one extended thinking pass, and emit all tool calls without intermediate observations. Different from `plan_steps` because the model plans from real page state rather than guessing selectors.

**Selector memory across runs.** The model rediscovers CSS selectors for the same site on every run. Storing working selectors per site/page in a persistent file (e.g. `workspace/selectors.json`) would let future runs skip the discovery step and fail less often on first attempt.

**Computer use (vision-based clicks).** Instead of DOM extraction + CSS selectors, give the model a screenshot and let it click by pixel coordinates. Removes the "find the right selector" failure mode entirely. Anthropic's computer use API supports this. Trade-off: slower per action, but more robust on sites with unstable or obfuscated DOM.

**Robust plan-then-execute.** The `plan_steps` tool (on `experiment/plan-then-execute`) reduces API round trips from N to ~2 by having the model emit all actions upfront and executing them without re-querying. It failed in testing because a single selector error aborted the whole plan, forcing a slow reactive recovery. The fix is partial-plan recovery: on error, resume from the failed step reactively rather than abandoning the whole sequence. This is the highest-leverage latency improvement — going from 5 API round trips to 2 would cut ~10s off each run. Needs more robust error handling in `plan-steps-tool.ts` before merging to main.

**Streaming tool execution.** Currently the loop waits for the full model response before executing any tool. With streaming, tool calls could be dispatched as soon as they appear in the stream, shaving 1-2s off each turn by overlapping model generation with tool execution. Worth ~3-5s total saving — incremental, not a breakthrough.
