# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run marionet -- run "<task>"   # run the agent
npm run marionet -- transcript     # render latest run to markdown (useful if run was killed)
npm run marionet -- transcript <run-id>

npm run typecheck                  # type-check orchestrator + both MCP workspaces
npm test                           # vitest unit tests (orchestrator only; no browser/shell)
```

Before any browser task, start Chrome with the debug port in a separate terminal:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/marionet-chrome
```

## Architecture

Marionet is a thin agentic loop around the Anthropic API. It gives the model shell, filesystem, and browser access via MCP servers, then controls what it's allowed to do through a policy engine.

```
cli.ts
 ├── McpClientManager   – spawns MCP servers as stdio subprocesses, routes tool calls
 ├── PolicyEngine       – evaluates every tool call before execution; fail-closed
 ├── runAgentLoop       – the core loop: call API → handle tool calls → repeat
 └── RunLogger          – append-only events.jsonl + meta.json per run
```

### Agent loop (`src/loop/agent-loop.ts`)

One iteration = one Anthropic API call. The loop handles three cases per response:
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
- `browser__fill_from_env` — fills an input from a named env var; the secret value never reaches the model. Use this instead of `browser__fill` for passwords/API keys.
- `browser__submit_form` — finds `[type=submit]` within the given selector and clicks it. Works for standard HTML forms; does **not** work for JS-driven forms with no native submit button, or submit buttons outside the `<form>` tag (use `browser__click` directly in those cases). If broadening: consider an explicit `submitSelector` param.

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

**Change the model or ceilings**: edit `config/run.config.json` (`model`, `maxTurns`, `maxCostUsd`, `maxTokens`). Pricing constants for cost estimation live in `src/anthropic-client.ts` and need manual updates if the model changes.

## Future directions

These were identified through experimentation but not yet implemented on main. Branches `experiment/faster-browser-loop` (Haiku + no-verify prompt) and `experiment/plan-then-execute` (`plan_steps` tool) exist for reference.

**Extended thinking + upfront page snapshot.** The core bottleneck is the perceive-decide-act cycle: every observation costs a full API round trip. The hypothesis is to give the model a rich initial snapshot (full DOM, accessibility tree, or screenshot) at the start of a flow, let it reason through the entire sequence in one extended thinking pass, and emit all tool calls without intermediate observations. Different from `plan_steps` because the model plans from real page state rather than guessing selectors.

**Selector memory across runs.** The model rediscovers CSS selectors for the same site on every run. Storing working selectors per site/page in a persistent file (e.g. `workspace/selectors.json`) would let future runs skip the discovery step and fail less often on first attempt.

**Computer use (vision-based clicks).** Instead of DOM extraction + CSS selectors, give the model a screenshot and let it click by pixel coordinates. Removes the "find the right selector" failure mode entirely. Anthropic's computer use API supports this. Trade-off: slower per action, but more robust on sites with unstable or obfuscated DOM.

**Robust plan-then-execute.** The `plan_steps` tool (on `experiment/plan-then-execute`) reduces API round trips from N to ~2 by having the model emit all actions upfront and executing them without re-querying. It failed in testing because a single selector error aborted the whole plan, forcing a slow reactive recovery. The fix is partial-plan recovery: on error, resume from the failed step reactively rather than abandoning the whole sequence. This is the highest-leverage latency improvement — going from 5 API round trips to 2 would cut ~10s off each run. Needs more robust error handling in `plan-steps-tool.ts` before merging to main.

**Streaming tool execution.** Currently the loop waits for the full model response before executing any tool. With streaming, tool calls could be dispatched as soon as they appear in the stream, shaving 1-2s off each turn by overlapping model generation with tool execution. Worth ~3-5s total saving — incremental, not a breakthrough.
