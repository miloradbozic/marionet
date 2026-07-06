# Phase 6 — Docker-sandboxed shell + effect-based egress policy

Implementation plan for DESIGN.md's Phase 6 (`feat/sandbox`, not started). Written to be
picked up and executed on another machine — self-contained, no external context needed.

## Context

DESIGN.md's roadmap lists Phase 6 as not started: `shell__exec` today runs bare bash
on the host (`mcp-servers/core/src/server.ts`), with no isolation between clients beyond
already-filtered env vars (`filterEnvForClient`). Marionet is a multi-client consulting
tool — one operator, several clients each with their own infra/credentials — and nothing
currently stops a shell command run for one client from reading another client's
directory or reaching arbitrary hosts. DESIGN.md's acceptance bar: *"a sandboxed command
cannot read another client's mounts or reach a non-allowlisted host; policy tests cover
the new rules."*

**Decisions already made** (do not re-litigate these):
- Escape hatch is a flag, not a separate tool: `shell__exec` gets an optional
  `unsandboxed: boolean` arg. When true, the command runs on the bare host exactly like
  today, gated by a new `ask` policy rule. When false/absent and a client is active, it
  runs inside that client's sandbox container.
- Full slice: mount isolation **and** the network egress firewall **and** an integration
  test, in one pass — mount isolation alone does not satisfy the acceptance bar.
- No client active (default/dev profile, no `--client` flag) → sandboxing is skipped
  entirely, identical to today's behavior. This mirrors the existing precedent in
  `filterEnvForClient` (`src/clients/client-profile.ts`): no profile means everything
  is forwarded/unrestricted; a profile means isolation kicks in.

## Architecture

### Container lifecycle
One Docker container per **(client, mcp-core-subprocess)**, started lazily on the first
`shell__exec` call and torn down when the subprocess exits. Name it
`marionet-sandbox-${client}-${process.pid}` (pid of the `mcp-servers/core` subprocess,
which is 1:1 with a `marionet run`/`replay` invocation via `McpClientManager.connectAll`
in `src/mcp/mcp-client-manager.ts`) — this avoids collisions across concurrent runs for
the same client and keeps lifetime scoped correctly.

The container stays up for the whole run (`sleep infinity` after firewall init) so state
persists across multiple `shell__exec` calls within one run (e.g. a package install
followed by a script that uses it) — matching the "per-client containers" phrasing in
DESIGN.md, not a fresh container per call.

Cleanup: register `process.on("exit"|"SIGINT"|"SIGTERM")` handlers in
`mcp-servers/core/src/server.ts` that `docker rm -f` the container. Best-effort — if the
process is killed with SIGKILL the container leaks; acceptable for now (matches the
existing CDP-websocket-keeps-node-alive tradeoff already documented in CLAUDE.md for the
browser server).

### Docker image
New `mcp-servers/core/sandbox/Dockerfile`, tagged `marionet-sandbox:latest`. Base:
`node:20-slim` or `alpine` (prefer alpine for smaller/faster builds) with `bash curl git
jq iptables ipset` installed, plus `kubectl` (curl-downloaded pinned version in the
Dockerfile). Built lazily by the sandbox module if `docker image inspect
marionet-sandbox:latest` fails — one-time cost, then cached like any Docker image.

Image `ENTRYPOINT` is `mcp-servers/core/sandbox/firewall-init.sh`, which:
1. Reads `$EGRESS_ALLOWLIST` (comma-separated hostnames/CIDRs) from the container env.
2. Creates an ipset (`allowed-egress`), resolves each hostname via `dig +short` (or
   `getent hosts`) and adds the IPs; adds CIDR entries directly.
3. Sets iptables default-deny: `OUTPUT` policy `DROP`, but `ACCEPT` for: loopback,
   established/related connections, DNS (UDP/TCP port 53 to the container's configured
   resolvers — must stay open, since hostnames may need re-resolving later), and any
   destination matching the `allowed-egress` ipset.
4. `exec`s the container's long-running command (`sleep infinity`) so `docker exec` can
   be used for actual commands afterward.

Container must run with `--cap-add=NET_ADMIN --cap-add=NET_RAW` for iptables/ipset to
work.

This is real network-level containment (DESIGN.md: *"policy moves from string-matching
to effect containment"*) — not an opt-in proxy env var a command could ignore.

### Mounts
- `workspace/` (repo-root-relative, absolute path) → `/workspace` in the container,
  read-write. Same directory `fs__read`/`fs__write`/`fs__list` already default to.
- `clients/<name>/` → `/client`, read-write (playbooks/skills live here; shell-driven
  writes should land in the same place `fs__write`'s absolute-path convention already
  uses).
- `clients/<name>/kubeconfig` (new convention, gitignored, operator-provided scaffolding
  like `profile.json`) → `/home/sandbox/.kube/config`, read-only, **only if the file
  exists**. Container env sets `KUBECONFIG=/home/sandbox/.kube/config` unconditionally;
  if the file wasn't mounted, `kubectl` simply fails clearly rather than falling back to
  a shared/default context. Nothing else from the host is mounted — specifically not
  other clients' directories, not the marionet repo source, not `~/.ssh` or other
  credential dirs.

### Egress allowlist config
Extend `ClientProfileConfig` (`src/clients/client-profile.ts`) with:
```ts
egressAllowlist?: string[]; // hostnames or CIDRs, e.g. ["test-opari.cloud.akeneo.com", "*.mongodb.net"]
```
Add a base allowlist every sandbox gets regardless of client (npm registry, github.com,
objects.githubusercontent.com for `git`/`npm` operations) as a constant in the new
sandbox module, concatenated with the client's list.

For `opari` specifically: needs `test-opari.cloud.akeneo.com`, MongoDB Atlas hosts, and
the k3d API server address — the k3d cluster observed running (`k3d-opari-server-0`)
exposes its API on a mapped localhost port, so the operator will need to add the
container's route to the host (`host.docker.internal` or the Docker bridge gateway IP)
to `clients/opari/profile.json`'s `egressAllowlist` once this lands — call this out
explicitly as a follow-up manual step, not something the code can infer.

### Config additions
`config/run.config.json` gets a `sandbox` block:
```json
"sandbox": {
  "image": "marionet-sandbox:latest",
  "baseEgressAllowlist": ["registry.npmjs.org", "github.com", "objects.githubusercontent.com"]
}
```

### Env wiring (orchestrator → mcp-servers/core subprocess)
`McpClientManager.connectAll` (`src/mcp/mcp-client-manager.ts`) already injects
`MARIONET_BROWSER_CDP_ENDPOINT` into the spawned subprocess env — follow the same
pattern. Add a `sandboxConfig` param threaded from `cli.ts`'s `runCommand`/
`replayCommand` (both already build `profile` and call `filterEnvForClient`), injecting:
- `MARIONET_CLIENT` (client name, absent if no `--client`)
- `MARIONET_CLIENT_DIR` (absolute path to `clients/<name>/`)
- `MARIONET_WORKSPACE_DIR` (absolute path to `workspace/`)
- `MARIONET_KUBECONFIG_PATH` (absolute, only if the file exists)
- `MARIONET_EGRESS_ALLOWLIST` (comma-joined base + client list)
- `MARIONET_SANDBOX_IMAGE`

`mcp-servers/core/src/server.ts` only sandboxes when `MARIONET_CLIENT` is present in its
env — this is the single on/off switch, keeping the no-client path byte-for-byte
identical to today.

### shell__exec changes
New module `mcp-servers/core/src/sandbox.ts`:
```ts
export function sandboxEnabled(): boolean;              // MARIONET_CLIENT set?
export async function ensureSandbox(): Promise<string>; // idempotent; builds image if missing, starts container if not running, returns containerId
export async function execInSandbox(containerId: string, command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
export async function teardownSandbox(): Promise<void>;
```
In `server.ts`'s `shell__exec` handler: if `args.unsandboxed === true` OR
`!sandboxEnabled()`, keep today's bare `exec()` path unchanged. Otherwise
`await ensureSandbox()` then `execInSandbox(...)` instead of local `exec`. Register the
`process.on(...)` cleanup calling `teardownSandbox()`.

Update the tool's `inputSchema` to add:
```ts
unsandboxed: z.boolean().optional().describe(
  "Bypass the per-client sandbox and run directly on the host. Ask-gated by policy — only use when the sandboxed container genuinely cannot do the job."
)
```

### Policy rule
`config/policy.json5` — add before the existing `{ match: "shell__exec", action: "allow" }`:
```json5
{
  match: "shell__exec",
  when: { argsMatch: { unsandboxed: "^true$" } },
  action: "ask",
},
```
`PolicyEngine.evaluate` (`src/policy/policy-engine.ts`) already supports `argsMatch`
against stringified arg values — `String(true) === "true"` matches `^true$` — no engine
changes needed, first-match-wins ordering handles it.

## Files to touch
- `mcp-servers/core/sandbox/Dockerfile` (new)
- `mcp-servers/core/sandbox/firewall-init.sh` (new)
- `mcp-servers/core/src/sandbox.ts` (new)
- `mcp-servers/core/src/server.ts` — wire `shell__exec` through sandbox.ts, add
  `unsandboxed` schema field, cleanup handlers
- `src/clients/client-profile.ts` — `egressAllowlist?: string[]` on
  `ClientProfileConfig`, a helper resolving the kubeconfig path if present
- `src/mcp/mcp-client-manager.ts` — extend `connectAll` to accept and inject the new
  `MARIONET_*` sandbox env vars
- `src/cli.ts` — build the sandbox env block in `runCommand`/`replayCommand` alongside
  the existing `filterEnvForClient` call
- `config/run.config.json` — `sandbox` block
- `config/policy.json5` — new `ask`-gated rule
- `clients/example/profile.json` — document the new `egressAllowlist` field
- `.gitignore` — ensure `clients/*/kubeconfig` is ignored (client secret-ish)
- Tests (see below)

## Testing plan
Mirror the existing `describe.skipIf(!chromeAvailable)` convention
(`test/golden-loop.test.ts`, `test/browser-snapshot.test.ts`) with a Docker-availability
check:
```ts
const dockerAvailable = /* `docker version` exits 0 */;
describe.skipIf(!dockerAvailable)("sandbox (integration)", () => { ... });
```
New `test/sandbox.test.ts`:
1. **Mount isolation** — start two sandboxes for two fake clients with distinct
   `clients/<name>/` dirs; write a file into client A's mounted dir on the host; assert
   `docker exec` into client B's container cannot see it (and vice versa).
2. **Egress allowlist** — with a small allowlist (e.g. `["example.com"]` or a local test
   HTTP server reachable via the Docker bridge gateway), assert `curl --max-time 3` to an
   allowlisted host succeeds and to a non-allowlisted host (e.g. `1.1.1.1`) fails/times
   out from inside the container.
3. **Escape hatch** — `unsandboxed: true` runs outside the container (e.g. assert a
   marker file only present on the host, not in `/workspace` inside the container, is
   visible) and that policy.json5's new rule returns `ask` for it.
4. Keep these slow/real (like golden-loop) rather than mocking Docker — the whole point
   is proving actual containment, and Docker is confirmed installed on the original dev
   machine this plan was written on.

Also add a couple of fast unit tests (no Docker needed) for:
- `PolicyEngine` correctly returns `ask` for `shell__exec` with `unsandboxed: true` and
  `allow` for `unsandboxed` absent/false (extend `test/policy-engine.test.ts`).
- The env-block builder that turns a `ClientProfile` + `run.config.json` sandbox config
  into the `MARIONET_*` var set (pure function, easy to unit test without touching
  Docker).

## Verification (for whoever executes this plan)
1. `npm run typecheck` and `npm test` green, including the new Docker-gated tests when
   run on a machine with Docker.
2. Manually: `npm run marionet -- run --client opari "list files in /client"` and confirm
   the shell command only sees `opari`'s own directory contents, not other clients'.
3. Manually: run a command targeting a disallowed host (e.g. `curl ifconfig.me`) inside
   a client run and confirm it fails/times out; confirm an allowlisted host succeeds.
4. Confirm `unsandboxed: true` triggers the policy `ask` prompt in an interactive run.
5. Update `DESIGN.md`'s Phase 6 line from "not started" to "✅ merged" (or "in review")
   once landed, per the file's own instruction to "keep it current."
