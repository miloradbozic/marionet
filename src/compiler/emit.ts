import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import type { CompileResult } from "./compile.js";
import type { AnySkill } from "./skill.types.js";

export interface WrittenSkill {
  skill: AnySkill;
  path: string;
  overwrote: boolean;
}

/** Writes every compiled primitive + the flow (if any) as skills/<name>.json. */
export function writeSkillFiles(skillsDir: string, result: CompileResult): WrittenSkill[] {
  mkdirSync(skillsDir, { recursive: true });
  const all: AnySkill[] = [...result.primitives, ...(result.flow ? [result.flow] : [])];
  return all.map((skill) => {
    const outPath = path.join(skillsDir, `${skill.name}.json`);
    const overwrote = existsSync(outPath);
    writeFileSync(outPath, JSON.stringify(skill, null, 2) + "\n");
    return { skill, path: outPath, overwrote };
  });
}

/**
 * Appends compiler-observed system quirks to the client's learned playbook
 * (clients/<client>/playbooks/learned.md). Notes whose text already appears
 * anywhere in the file are skipped, so recompiling the same run doesn't pile
 * up duplicates. Returns the playbook path, or null if every note was a dupe.
 */
export function appendPlaybookNotes(repoRoot: string, client: string, runId: string, notes: string[]): string | null {
  const playbookDir = path.join(repoRoot, "clients", client, "playbooks");
  const playbookPath = path.join(playbookDir, "learned.md");
  const existing = existsSync(playbookPath) ? readFileSync(playbookPath, "utf-8") : "";

  const fresh = notes.map((n) => n.trim()).filter((n) => n && !existing.includes(n));
  if (!fresh.length) return null;

  mkdirSync(playbookDir, { recursive: true });
  const header = existing ? "" : "# Learned playbook\n\nQuirks observed by the trajectory compiler. Agent-written; review with git diff.\n";
  const section = `\n## From run ${runId}\n\n${fresh.map((n) => `- ${n}`).join("\n")}\n`;
  appendFileSync(playbookPath, header + section);
  return playbookPath;
}
