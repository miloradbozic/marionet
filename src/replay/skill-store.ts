import path from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AnySkill } from "../compiler/skill.types.js";

/**
 * Reads and writes the skill library of one client (clients/<name>/skills/
 * or workspace/skills/ for the default profile). Also the write-back target
 * for self-heal: a healed step is persisted so one heal fixes every future
 * replay -- and every flow that composes the healed primitive.
 */
export class SkillStore {
  constructor(readonly skillsDir: string) {}

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
    return JSON.parse(readFileSync(p, "utf-8")) as AnySkill;
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
