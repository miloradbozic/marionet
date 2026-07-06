import path from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AnySkill } from "../compiler/skill.types.js";

/**
 * Reads and writes the skill library of one client (clients/<name>/skills/
 * or workspace/skills/ for the default profile). Also the write-back target
 * for self-heal: a healed step is persisted so one heal fixes every future
 * replay -- and every flow that composes the healed primitive.
 *
 * Tenant isolation: every skill is stamped with the client it was compiled
 * for (`client?: string`, undefined for the unscoped default profile).
 * `load()` is the sole read path used by direct replay, flow expansion
 * (`resolvePlan` recurses through it), `run_skill`, and `marionet skills` --
 * so checking the stamp there, fail-closed, covers every consumer. This
 * catches a skill file ending up under the wrong client's directory (manual
 * copy, restored backup, future non-per-directory storage) even though
 * directory separation already prevents it in normal operation.
 */
export class SkillStore {
  constructor(
    readonly skillsDir: string,
    readonly expectedClient?: string,
  ) {}

  pathOf(name: string): string {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid skill name "${name}"`);
    return path.join(this.skillsDir, `${name}.json`);
  }

  has(name: string): boolean {
    return existsSync(this.pathOf(name));
  }

  load(name: string): AnySkill {
    const p = this.pathOf(name);
    if (!existsSync(p)) {
      throw new Error(`no skill "${name}" in ${this.skillsDir}${this.listNames().length ? ` (available: ${this.listNames().join(", ")})` : " (library is empty)"}`);
    }
    const skill = JSON.parse(readFileSync(p, "utf-8")) as AnySkill;
    if (skill.client !== this.expectedClient) {
      throw new Error(
        `tenant isolation: skill "${name}" in ${this.skillsDir} belongs to client ${JSON.stringify(skill.client ?? null)}, ` +
          `but this store is scoped to ${JSON.stringify(this.expectedClient ?? null)}`,
      );
    }
    return skill;
  }

  save(skill: AnySkill): string {
    const p = this.pathOf(skill.name);
    writeFileSync(p, JSON.stringify(skill, null, 2) + "\n");
    return p;
  }

  listNames(): string[] {
    if (!existsSync(this.skillsDir)) return [];
    return readdirSync(this.skillsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }

  list(): AnySkill[] {
    return this.listNames().map((n) => this.load(n));
  }
}
