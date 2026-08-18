/**
 * Skill materializer: syncs skill-kind harness entries to the DSH skills
 * filesystem so the `skill` tool and catalog can discover and load them.
 * Global entries land in the user-level skills root (`$DSH_HOME/skills/`);
 * project entries land in the project's own skills directory
 * (`<projectRoot>/.dsh/skills/`, scanned natively by the official
 * skill-filesystem provider); local entries are never materialized — they
 * stay in the store until promoted. Writes are atomic (tmp + rename) so the
 * filesystem watcher never sees a partial file.
 *
 * Skill names must be kebab-case (the harness store ids are underscore slugs;
 * the materialized name converts `_` → `-`).
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { HarnessEntry, RefinementResult } from "./types.js";
import { renderSkillMarkdown, skillNameOf } from "./skill-render.js";
import { skillResourceRefs, validateRenderedSkill } from "./skillquality.js";

export { renderSkillMarkdown, skillNameOf } from "./skill-render.js";

/** Resolve and defend the skill directory for an entry id. */
export function skillDir(skillsRoot: string, id: string): string {
	const root = resolve(skillsRoot);
	const dir = resolve(join(root, skillNameOf(id)));
	if (dir !== root && !dir.startsWith(`${root}/`) && !dir.startsWith(`${root}${sep}`)) {
		throw new Error(`skill path escapes skills root: ${dir}`);
	}
	return dir;
}

/**
 * Resolve the materialization root for one applied skill edit: the project's
 * `.dsh/skills` directory for project-scope edits, the user-level skills
 * root for global-scope edits. Local edits materialize nowhere.
 * @param skillsRoot - the user-level skills root.
 * @param entry - the applied entry (carries scope).
 * @param projectRoot - project root of the applied refinement, when any.
 * @returns the directory to write into, or undefined (no materialization).
 */
export function materializationRoot(skillsRoot: string, entry: HarnessEntry, projectRoot?: string): string | undefined {
	if (entry.scope === "project") {
		return projectRoot ? join(projectRoot, ".dsh", "skills") : undefined;
	}
	if (entry.scope === "global") {
		return skillsRoot;
	}
	return undefined;
}

/**
 * Apply the skill-kind edits of an applied refinement to the skills roots.
 * Returns materialization warnings (rendered-SKILL.md mechanical problems
 * and dangling resource references) — the file is still written, but the
 * caller should surface them: a rendered file that fails the platform's
 * frontmatter rules would be IGNORED by the skill loader, and a body
 * referencing resources the entry does not ship would load with broken
 * links.
 */
export function syncSkillsFromResult(skillsRoot: string, result: RefinementResult): string[] {
	const warnings: string[] = [];
	for (const edit of result.appliedEdits) {
		if (edit.kind !== "skill" || !edit.applied) continue;
		if (edit.action === "delete" || !edit.after) {
			// A delete does not carry the entry's scope; remove the file from
			// every root it could have been materialized into.
			removeSkill(skillsRoot, edit.id);
			if (result.projectRoot) removeSkill(join(result.projectRoot, ".dsh", "skills"), edit.id);
			continue;
		}
		const root = materializationRoot(skillsRoot, edit.after, result.projectRoot);
		if (root === undefined) {
			// Local-scope skills stay in the store until promoted.
			continue;
		}
		warnings.push(...writeSkill(root, edit.after));
	}
	return warnings;
}

/** Write one skill entry as a SKILL.md; returns materialization warnings. */
function writeSkill(skillsRoot: string, entry: HarnessEntry): string[] {
	const dir = skillDir(skillsRoot, entry.id);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, `SKILL.md.${process.pid}.tmp`);
	writeFileSync(temp, renderSkillMarkdown(entry), "utf8");
	renameSync(temp, join(dir, "SKILL.md"));
	return materializationWarnings(dir, entry);
}

/** Post-write checks on the exact file that landed on disk. */
function materializationWarnings(dir: string, entry: HarnessEntry): string[] {
	const warnings: string[] = [];
	for (const problem of validateRenderedSkill(entry)) {
		warnings.push(`skill ${entry.id}: rendered SKILL.md would be ignored by the platform: ${problem}`);
	}
	const root = resolve(dir);
	for (const ref of skillResourceRefs(entry.content)) {
		const target = resolve(root, ref);
		if (target !== root && !target.startsWith(`${root}${sep}`)) {
			warnings.push(`skill ${entry.id}: body resource reference escapes the skill directory: ${ref}`);
			continue;
		}
		if (!existsSync(target)) {
			warnings.push(`skill ${entry.id}: body references missing resource ${ref} (expected at ${target})`);
		}
	}
	return warnings;
}

function removeSkill(skillsRoot: string, id: string): void {
	const dir = skillDir(skillsRoot, id);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
}
