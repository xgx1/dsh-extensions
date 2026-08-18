/**
 * Tests for the fork's unfinished-work continuation: message text, todo
 * projection filtering, and the bounded continue decision (goal-owned
 * sessions skip, cap distillation, counter reset).
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
	checkAndContinue,
	continueMessageText,
	CONTINUE_MESSAGE_PREFIX,
	createContinueState,
	unfinishedTodosOf,
	type ContinueState,
} from "../src/continue.js";
import { splitByBlastRadius } from "../src/auto.js";
import type { RefinementProposal } from "../src/types.js";

function agentWithFollowup(): Agent & { followup: ReturnType<typeof vi.fn> } {
	return {
		id: "s1",
		session: {},
		followup: vi.fn(),
	} as unknown as Agent & { followup: ReturnType<typeof vi.fn> };
}

function ctxWithTodos(todos: unknown): Context {
	return {
		get: (name: string) =>
			name === "sessionProjections"
				? { snapshot: () => ({ values: { todos } }) }
				: undefined,
		logger: () => ({ info: () => {}, warn: () => {} }),
	} as unknown as Context;
}

function ctxWithGoal(): Context {
	return {
		get: (name: string) =>
			name === "goals"
				? { get: () => ({ phase: "active", objective: "g", id: "g1", revision: 1, maxGoalRounds: 5 }) }
				: undefined,
		logger: () => ({ info: () => {}, warn: () => {} }),
	} as unknown as Context;
}

describe("continueMessageText", () => {
	it("lists up to five items with the total count", () => {
		const items = [
			{ content: "a", status: "pending" },
			{ content: "b", status: "in_progress" },
			{ content: "c", status: "pending" },
			{ content: "d", status: "pending" },
			{ content: "e", status: "pending" },
			{ content: "f", status: "pending" },
		];
		const text = continueMessageText(items);
		expect(text.startsWith(CONTINUE_MESSAGE_PREFIX)).toBe(true);
		expect(text).toContain("a；b；c；d；e");
		expect(text).toContain("共 6 项");
	});
});

describe("unfinishedTodosOf", () => {
	it("keeps pending and in_progress items only", () => {
		const ctx = ctxWithTodos([
			{ content: "todo", status: "pending" },
			{ content: "doing", status: "in_progress" },
			{ content: "done", status: "completed" },
		]);
		const items = unfinishedTodosOf(ctx, agentWithFollowup());
		expect(items?.map((item) => item.content)).toEqual(["todo", "doing"]);
	});

	it("returns undefined when the projection is absent", () => {
		const ctx = ctxWithTodos(null);
		expect(unfinishedTodosOf(ctx, agentWithFollowup())).toBeUndefined();
	});
});

describe("checkAndContinue", () => {
	it("skips sessions with an active goal (official driver owns continuation)", () => {
		const state: ContinueState = createContinueState();
		const agent = agentWithFollowup();
		const engine = { apply: vi.fn() } as never;
		expect(checkAndContinue(ctxWithGoal(), engine, agent, 3, state)).toBe(false);
		expect(agent.followup).not.toHaveBeenCalled();
	});

	it("resets the counter and does nothing without unfinished todos", () => {
		const state: ContinueState = { rounds: 2 };
		const agent = agentWithFollowup();
		const engine = { apply: vi.fn() } as never;
		expect(checkAndContinue(ctxWithTodos([]), engine, agent, 3, state)).toBe(false);
		expect(state.rounds).toBe(0);
		expect(agent.followup).not.toHaveBeenCalled();
	});

	it("sends one bounded follow-up and increments the counter", () => {
		const state: ContinueState = createContinueState();
		const agent = agentWithFollowup();
		const engine = { apply: vi.fn() } as never;
		const ctx = ctxWithTodos([{ content: "finish the thing", status: "pending" }]);
		expect(checkAndContinue(ctx, engine, agent, 3, state)).toBe(true);
		expect(agent.followup).toHaveBeenCalledTimes(1);
		const message = agent.followup.mock.calls[0]?.[0] as { content: { text: string }[] };
		expect(message.content[0]?.text).toContain("finish the thing");
		expect(state.rounds).toBe(1);
	});

	it("distills a memory entry instead of continuing when the cap is reached", () => {
		const state: ContinueState = { rounds: 3 };
		const agent = agentWithFollowup();
		const engine = { apply: vi.fn() } as never;
		const ctx = ctxWithTodos([
			{ content: "leftover a", status: "pending" },
			{ content: "leftover b", status: "in_progress" },
		]);
		expect(checkAndContinue(ctx, engine, agent, 3, state)).toBe(false);
		expect(agent.followup).not.toHaveBeenCalled();
		expect(engine.apply).toHaveBeenCalledTimes(1);
		const call = (engine.apply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, { edits: { kind: string }[] }];
		expect(call[0]).toBe("local");
		expect(call[2].edits[0]?.kind).toBe("memory");
	});
});

describe("splitByBlastRadius", () => {
	it("routes project edits apart from the rest", () => {
		const proposal: RefinementProposal = {
			summary: "s",
			rationale: "r",
			expectedOutcome: "o",
			edits: [
				{ action: "create", kind: "memory", title: "a", blastRadius: "session" },
				{ action: "create", kind: "memory", title: "b", blastRadius: "project" },
				{ action: "create", kind: "memory", title: "c" },
			],
		};
		const { projectEdits, localEdits } = splitByBlastRadius(proposal);
		expect(projectEdits.map((edit) => edit.title)).toEqual(["b"]);
		expect(localEdits.map((edit) => edit.title)).toEqual(["a", "c"]);
	});
});
