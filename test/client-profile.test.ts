import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  filterEnvForClient,
  listClients,
  loadClientProfile,
  renderClientPromptSection,
} from "../src/clients/client-profile.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";

let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(path.join(os.tmpdir(), "marionet-clients-"));

  // Client A: playbooks + client policy override.
  const a = path.join(repoRoot, "clients", "acme");
  mkdirSync(path.join(a, "playbooks"), { recursive: true });
  writeFileSync(path.join(a, "profile.json"), JSON.stringify({ description: "Acme Corp", envPrefix: "ACME_" }));
  writeFileSync(path.join(a, "playbooks", "shop.md"), "# Acme shop\nThe save button is JS-rendered.");
  writeFileSync(
    path.join(a, "policy.json5"),
    `{ rules: [ { match: "browser__submit_form", action: "allow" } ] }`,
  );

  // Client B: legacy unprefixed vars via allowlist, no playbooks yet.
  const b = path.join(repoRoot, "clients", "beta");
  mkdirSync(b, { recursive: true });
  writeFileSync(path.join(b, "profile.json"), JSON.stringify({ envAllowlist: ["LEGACY_TOKEN"] }));

  writeFileSync(
    path.join(repoRoot, "global-policy.json5"),
    `{ rules: [ { match: "browser__submit_form", action: "ask" }, { match: "*", action: "deny" } ] }`,
  );
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("client profiles", () => {
  it("loads profile config and playbooks", () => {
    const profile = loadClientProfile(repoRoot, "acme");
    expect(profile.config.description).toBe("Acme Corp");
    expect(profile.playbooks).toHaveLength(1);
    expect(profile.playbooks[0]!.name).toBe("shop.md");
    expect(profile.playbooks[0]!.content).toContain("JS-rendered");
    expect(profile.policyPath).toBeTruthy();
  });

  it("rejects unknown clients and lists the available ones", () => {
    expect(() => loadClientProfile(repoRoot, "nope")).toThrow(/Available clients: acme, beta/);
    expect(listClients(repoRoot)).toEqual(["acme", "beta"]);
  });

  it("renders playbooks into the prompt section", () => {
    const section = renderClientPromptSection(loadClientProfile(repoRoot, "acme"));
    expect(section).toContain('client "acme"');
    expect(section).toContain("The save button is JS-rendered.");
  });

  it("tells the agent to author the first playbook when none exist", () => {
    const section = renderClientPromptSection(loadClientProfile(repoRoot, "beta"));
    expect(section).toMatch(/No playbooks exist.*write a playbook/s);
  });
});

describe("env isolation between clients", () => {
  const env = {
    PATH: "/usr/bin",
    MARIONET_BROWSER_CDP_ENDPOINT: "http://localhost:9222",
    ACME_API_KEY: "acme-secret",
    LEGACY_TOKEN: "beta-secret",
    OPENROUTER_API_KEY: "orchestrator-only",
  } as NodeJS.ProcessEnv;

  it("forwards only the client's own vars plus infrastructure", () => {
    const acmeEnv = filterEnvForClient(env, loadClientProfile(repoRoot, "acme"));
    expect(acmeEnv).toHaveProperty("ACME_API_KEY");
    expect(acmeEnv).toHaveProperty("PATH");
    expect(acmeEnv).toHaveProperty("MARIONET_BROWSER_CDP_ENDPOINT");
    expect(acmeEnv).not.toHaveProperty("LEGACY_TOKEN"); // other client's secret
    expect(acmeEnv).not.toHaveProperty("OPENROUTER_API_KEY"); // orchestrator-only

    const betaEnv = filterEnvForClient(env, loadClientProfile(repoRoot, "beta"));
    expect(betaEnv).toHaveProperty("LEGACY_TOKEN");
    expect(betaEnv).not.toHaveProperty("ACME_API_KEY");
  });

  it("passes everything through when no client is set (default profile)", () => {
    const all = filterEnvForClient(env, undefined);
    expect(all).toHaveProperty("ACME_API_KEY");
    expect(all).toHaveProperty("LEGACY_TOKEN");
  });
});

describe("per-client policy overrides", () => {
  it("client rules are evaluated before global rules (first match wins)", () => {
    const globalOnly = new PolicyEngine(path.join(repoRoot, "global-policy.json5"));
    expect(globalOnly.evaluate("browser__submit_form", {}).action).toBe("ask");

    const withClient = new PolicyEngine(
      path.join(repoRoot, "global-policy.json5"),
      path.join(repoRoot, "clients", "acme", "policy.json5"),
    );
    expect(withClient.evaluate("browser__submit_form", {}).action).toBe("allow");
    // Global catch-all still applies to everything else.
    expect(withClient.evaluate("payments__charge_card", {}).action).toBe("deny");
    // The merged snapshot is what gets written to meta.json.
    expect(withClient.snapshot.rules[0]).toEqual({ match: "browser__submit_form", action: "allow" });
  });
});
