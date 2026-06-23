# marionet

A testbed for fully agentic solutions: an agent with the same access a human operator would have — files, shell, browser, apps — and the latitude to decide how to use it.

The name is a deliberate inversion of Puppeteer: a puppet on strings is *controlled*; this one isn't.

## Goal

Explore how far an agent can go when it isn't boxed into a narrow tool API — what it can accomplish, and where giving it broad access actually breaks down in practice (safety, reliability, judgment).

## Ground rules

- No evading anti-automation or anti-bot detection (e.g. stealth browser plugins, spoofing `navigator.webdriver`). If a flow needs SSO login, authenticate manually in a plain browser first, then have the agent attach to that session.
- Treat irreversible or high-blast-radius actions (deleting data, pushing to shared remotes, sending messages, spending money) as requiring a human checkpoint, even when the agent technically *could* do them unattended.
- Log what the agent did and why it chose to, well enough that a run can be reconstructed after the fact.

## Status

Just scaffolded — no code yet.
