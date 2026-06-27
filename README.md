# marionet

A testbed for fully agentic solutions: an agent with the same access a human operator would have — files, shell, browser, apps — and the latitude to decide how to use it.

The name is a deliberate inversion of Puppeteer: a puppet on strings is *controlled*; this one isn't.

## Goal

Explore how far an agent can go when it isn't boxed into a narrow tool API — what it can accomplish, and where giving it broad access actually breaks down in practice (safety, reliability, judgment).

## Ground rules

- Shell commands (including sudo) run unattended by default. A denylist still pauses for confirmation: disk-destroying commands (rm -rf /, mkfs, dd to a disk device), fork bombs, shutdown/reboot, piping a remote script straight into a shell, and `git push` to a remote.
- No evading anti-automation or anti-bot detection (e.g. stealth browser plugins, spoofing `navigator.webdriver`). If a flow needs SSO login, authenticate manually in a plain browser first, then have the agent attach to that session.
- Outside of shell: treat irreversible or high-blast-radius actions — sending messages, completing payments, GUI/desktop control — as requiring a human checkpoint, even though the agent could technically do them unattended.
- Log what the agent did and why it chose to, well enough that a run can be reconstructed after the fact.

## Usage

```
npm install
npm run marionet -- run "list the files in workspace/ and tell me what you see"
```

For tasks that need the browser tool, start Chrome yourself first (so the agent attaches to an already-authenticated session instead of triggering a fresh, automation-flagged login):

```
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/marionet-chrome
```

Log into whatever sites the task needs in that window, then run marionet.

Permission rules live in `config/policy.json5`; run settings (model, turn/cost ceilings, MCP server list) in `config/run.config.json`. Every run is logged under `runs/<run-id>/`.

If a run gets killed (Ctrl-C, crash) before it finalizes, `events.jsonl` still has the full history but `transcript.md` never got written. Render it after the fact:

```
npm run marionet -- transcript            # latest run
npm run marionet -- transcript <run-id>   # a specific one
```

## Status

v1 implemented: agent loop, shell/filesystem MCP server, browser (CDP-attach) MCP server, permission policy engine, run logging. GUI/desktop control is stubbed, not yet implemented.
