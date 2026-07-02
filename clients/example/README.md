# Client profiles

One directory per client. Runs are invoked as `marionet run --client <name> "<task>"`; the loop
loads only that client's playbooks and forwards only that client's env vars to MCP subprocesses,
so one client's run can never read another client's secrets.

```
clients/<name>/
  profile.json     # scaffolding you author: env-var prefix/allowlist, description
  policy.json5     # optional: policy rules evaluated BEFORE config/policy.json5 (first match wins)
  playbooks/*.md   # learned: written and updated by marionet after exploration runs
  skills/*.json    # learned: compiled flows (Phase 4+)
```

`profile.json` fields:

- `envPrefix` — env vars starting with this prefix are forwarded (e.g. `"OPARI_"`).
- `envAllowlist` — exact var names to forward, for legacy unprefixed vars.
- `description` — one line shown to the model as client context.

Client directories are gitignored (they contain client-specific knowledge); this example is the
only one committed. If you want client knowledge version-controlled — recommended, playbooks are
reviewable like code — run `git init` inside the client directory or symlink it from a private repo.
