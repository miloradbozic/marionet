import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Client profiles: per-client scaffolding + learned knowledge.
 *
 * A profile directory (clients/<name>/) is *scaffolding you author once*
 * (profile.json, optional policy.json5) plus *knowledge marionet writes
 * itself* (playbooks/, and skills/ once the Phase 4 compiler lands).
 * Nothing in the core knows any client's systems; onboarding a client is
 * creating a directory, not editing the prompt or the code.
 */

export interface ClientProfileConfig {
  description?: string;
  /** Env vars starting with this prefix are forwarded to MCP subprocesses (e.g. "OPARI_"). */
  envPrefix?: string;
  /** Exact env var names to forward (for legacy unprefixed vars like AKENEO_PASSWORD). */
  envAllowlist?: string[];
}

export interface ClientPlaybook {
  /** Absolute path, so the agent can update the playbook via fs__write. */
  path: string;
  name: string;
  content: string;
}

export interface ClientProfile {
  name: string;
  dir: string;
  config: ClientProfileConfig;
  playbooks: ClientPlaybook[];
  /** clients/<name>/policy.json5, if present. Rules are evaluated before the global policy. */
  policyPath?: string;
}

export function listClients(repoRoot: string): string[] {
  const clientsRoot = path.join(repoRoot, "clients");
  if (!existsSync(clientsRoot)) return [];
  return readdirSync(clientsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "example")
    .map((e) => e.name)
    .sort();
}

export function loadClientProfile(repoRoot: string, name: string): ClientProfile {
  const dir = path.join(repoRoot, "clients", name);
  const profilePath = path.join(dir, "profile.json");
  if (!existsSync(profilePath)) {
    const available = listClients(repoRoot);
    throw new Error(
      `No client profile at ${profilePath}.` +
        (available.length ? ` Available clients: ${available.join(", ")}` : " No clients defined yet -- create clients/<name>/profile.json (see clients/example/)."),
    );
  }
  const config = JSON.parse(readFileSync(profilePath, "utf-8")) as ClientProfileConfig;

  const playbooksDir = path.join(dir, "playbooks");
  const playbooks: ClientPlaybook[] = existsSync(playbooksDir)
    ? readdirSync(playbooksDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({
          path: path.join(playbooksDir, f),
          name: f,
          content: readFileSync(path.join(playbooksDir, f), "utf-8"),
        }))
    : [];

  const policyPath = path.join(dir, "policy.json5");
  return {
    name,
    dir,
    config,
    playbooks,
    policyPath: existsSync(policyPath) ? policyPath : undefined,
  };
}

/** Infrastructure vars every MCP subprocess needs regardless of client. */
const BASE_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "NODE_ENV",
  "NODE_OPTIONS",
]);

/**
 * Env forwarded to MCP subprocesses. Without a client profile, everything is
 * forwarded (backward-compatible default profile). With one, only base
 * infrastructure vars, MARIONET_* vars, and the client's own prefix/allowlist
 * pass through -- so a run for one client cannot read another client's
 * secrets, from the browser fill tool or from the shell.
 */
export function filterEnvForClient(
  env: NodeJS.ProcessEnv,
  profile: ClientProfile | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!profile) {
      result[key] = value;
      continue;
    }
    const allowed =
      BASE_ENV_ALLOWLIST.has(key) ||
      key.startsWith("MARIONET_") ||
      (profile.config.envPrefix ? key.startsWith(profile.config.envPrefix) : false) ||
      (profile.config.envAllowlist?.includes(key) ?? false);
    if (allowed) result[key] = value;
  }
  return result;
}

/** Client section appended to the system prompt: identity + inlined playbooks. */
export function renderClientPromptSection(profile: ClientProfile): string {
  const parts = [
    `\nClient context: you are working for client "${profile.name}".` +
      (profile.config.description ? ` ${profile.config.description}` : ""),
  ];
  if (profile.playbooks.length === 0) {
    parts.push(
      "No playbooks exist for this client yet. When you learn how one of this client's systems works (URLs, quirks, working selectors, login flow), write a playbook to " +
        `${profile.dir}/playbooks/<system>.md via fs__write so future runs skip the discovery.`,
    );
  } else {
    parts.push(
      "Playbooks for this client's systems are below. When a playbook covers a step, follow it exactly without extra inspection. " +
        "If you discover something a playbook got wrong or missed, update the playbook file via fs__write (paths are absolute).",
    );
    for (const pb of profile.playbooks) {
      parts.push(`\n--- Playbook: ${pb.name} (${pb.path}) ---\n${pb.content}`);
    }
  }
  return parts.join("\n");
}
