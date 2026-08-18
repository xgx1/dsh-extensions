/**
 * Tests for the fork's project scope: project-root resolution (git root
 * wins, cwd fallback) and the project store layout under the project's own
 * `.dsh/evolve` directory.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRootOf, resolveProjectRoot } from "../src/project.js";
import { storePaths } from "../src/store.js";
import { createEvolutionEngine } from "../src/service.js";
import { saveHarnessState, loadHarnessState } from "../src/state.js";
import { emptyHarnessState } from "../src/types.js";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "evolve-project-"));
}

describe("gitRootOf", () => {
	it("returns the nearest ancestor directory containing a .git directory", () => {
		const root = tmpRoot();
		try {
			const repo = join(root, "repo");
			const nested = join(repo, "src", "deep");
			mkdirSync(join(repo, ".git"), { recursive: true });
			mkdirSync(nested, { recursive: true });
			expect(gitRootOf(nested)).toBe(repo);
			expect(gitRootOf(repo)).toBe(repo);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns undefined when no ancestor carries a .git directory", () => {
		const root = tmpRoot();
		try {
			const nested = join(root, "a", "b");
			mkdirSync(nested, { recursive: true });
			expect(gitRootOf(nested)).toBeUndefined();
			expect(gitRootOf(undefined)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores a .git file (worktrees/submodules) and keeps walking", () => {
		const root = tmpRoot();
		try {
			const outer = join(root, "outer");
			const repo = join(outer, "repo");
			mkdirSync(repo, { recursive: true });
			mkdirSync(join(outer, ".git"), { recursive: true });
			writeFileSync(join(repo, ".git"), "gitdir: ../.git/worktrees/repo\n", "utf8");
			// outer carries a real .git directory above repo's file-only marker.
			expect(gitRootOf(repo)).toBe(outer);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveProjectRoot", () => {
	it("prefers the git root over the working directory", () => {
		const root = tmpRoot();
		try {
			const repo = join(root, "repo");
			const cwd = join(repo, "sub");
			mkdirSync(join(repo, ".git"), { recursive: true });
			mkdirSync(cwd, { recursive: true });
			expect(resolveProjectRoot(cwd)).toBe(repo);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to the working directory without a git root", () => {
		const root = tmpRoot();
		try {
			const cwd = join(root, "plain");
			mkdirSync(cwd, { recursive: true });
			expect(resolveProjectRoot(cwd)).toBe(cwd);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns undefined without a working directory", () => {
		expect(resolveProjectRoot(undefined)).toBeUndefined();
	});
});

describe("project store layout", () => {
	it("keeps the project store under <projectRoot>/.dsh/evolve", () => {
		const base = tmpRoot();
		const project = tmpRoot();
		try {
			const paths = storePaths(base, "project", undefined, project);
			expect(paths.stateDir).toBe(join(project, ".dsh", "evolve"));
			expect(paths.resultsPath).toBe(join(project, ".dsh", "evolve", "refinements.jsonl"));
			expect(storePaths(base, "global").stateDir).toBe(join(base, "evolve", "global"));
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("rejects a project store without a project root", () => {
		const base = tmpRoot();
		try {
			expect(() => storePaths(base, "project", undefined, undefined)).toThrow(/projectRoot/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("persists and reads project-scoped entries through the engine", () => {
		const base = tmpRoot();
		const project = tmpRoot();
		try {
			const engine = createEvolutionEngine(base);
			const state = emptyHarnessState();
			state.entries.memory["proj_fact"] = {
				id: "proj_fact",
				kind: "memory",
				title: "Project fact",
				content: "Only this project cares.",
				path: "general",
				scope: "project",
				reference: {},
				arguments: {},
				metadata: {},
				source: "evolve",
				created_at: "2026-08-14T00:00:00.000Z",
				updated_at: "2026-08-14T00:00:00.000Z",
				version: 1,
			};
			saveHarnessState(storePaths(base, "project", undefined, project).stateDir, state);
			const loaded = engine.load("project", undefined, project);
			expect(loaded.entries.memory["proj_fact"]?.scope).toBe("project");
			// The same engine does not see it under the global store.
			expect(engine.load("global", undefined).entries.memory["proj_fact"]).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});
});
