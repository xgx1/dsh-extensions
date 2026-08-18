/**
 * Project-root resolution: the current project for project-scoped harness
 * entries and project skill materialization. Git repository root wins (the
 * repository is the durable project boundary); without a git root the session
 * working directory is used as-is.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Maximum ancestor walk when hunting for a git root. */
const MAX_DEPTH = 64;

/**
 * Walk `cwd` upward and return the nearest directory containing a `.git`
 * directory, or undefined when none exists in the ancestor chain.
 * @param cwd - starting directory (e.g. the session working directory).
 * @returns the git repository root, or undefined.
 */
export function gitRootOf(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	let dir = resolve(cwd);
	for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
		const gitDir = join(dir, ".git");
		try {
			if (existsSync(gitDir) && statSync(gitDir).isDirectory()) {
				return dir;
			}
		} catch {
			// Unreadable ancestor: stop the walk, fall through to the cwd.
			break;
		}
		const parent = resolve(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * Resolve the project root for one session working directory: the git
 * repository root when one exists in the ancestor chain, otherwise the
 * working directory itself.
 * @param cwd - the session working directory.
 * @returns the project root, or undefined without a cwd.
 */
export function resolveProjectRoot(cwd: string | undefined): string | undefined {
	return gitRootOf(cwd) ?? (cwd ? resolve(cwd) : undefined);
}
