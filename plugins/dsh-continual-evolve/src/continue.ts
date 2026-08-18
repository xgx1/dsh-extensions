/**
 * Unfinished-work continuation (fork extension): after a turn closes and the
 * agent is idle, check whether anything remains unfinished — an active goal
 * (the official goal round driver already owns continuation) or pending todo
 * items — and, when it does, follow up with a bounded continuation message.
 *
 * Bounds: a per-session round counter caps automatic continuation at
 * `continueMaxRounds`; once the cap is reached the unfinished items are
 * distilled into a local memory entry (so the state survives) and the
 * session is left alone. The counter resets whenever nothing is unfinished.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { EvolutionEngine } from "./service.js";
import { goalServiceOf } from "./goal.js";

/** Per-session continuation state (one counter per agent). */
export interface ContinueState {
	/** Automatic continuation rounds already sent for the current unfinished set. */
	rounds: number;
}

/** Fresh continuation state. */
export function createContinueState(): ContinueState {
	return { rounds: 0 };
}

/** Minimal structural view of the todos projection (duck-typed). */
export interface TodoItemLike {
	content: string;
	status: string;
}

/** Message prefix marking hook-driven continuation (visible in the transcript). */
export const CONTINUE_MESSAGE_PREFIX = "[evolve-hook] 继续处理未完成任务";

/**
 * Build the follow-up message text for the unfinished todo items.
 * @param items - unfinished todo items (pending/in_progress).
 * @returns the continuation prompt text.
 */
export function continueMessageText(items: readonly TodoItemLike[]): string {
	const listed = items
		.slice(0, 5)
		.map((item) => item.content)
		.join("；");
	const rest = items.length > 5 ? `；等共 ${items.length} 项` : "";
	return `${CONTINUE_MESSAGE_PREFIX}（${items.length} 项待办）：${listed}${rest}`;
}

/**
 * Distill the unfinished items into a local memory entry so the state
 * survives even when the continuation cap is reached.
 * @param ctx - owning context (for logging).
 * @param engine - the evolution engine.
 * @param agent - the agent whose session owns the items.
 * @param items - the unfinished todo items.
 */
export function distillUnfinishedMemory(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	items: readonly TodoItemLike[],
): void {
	try {
		engine.apply(
			"local",
			agent.id,
			{
				summary: "未完成任务记录",
				rationale: "自动继续达到上限，未完成任务沉淀为记忆以防丢失",
				expectedOutcome: "后续会话可恢复这些任务",
				edits: [
					{
						action: "create",
						kind: "memory",
						title: "未完成任务（会话收尾）",
						content: items.map((item) => `- ${item.content}`).join("\n"),
						reason: "继续上限已到，未完成任务需要持久记录",
					},
				],
			},
			{ scope: "local" },
		);
	} catch (cause) {
		ctx.logger("continual-evolve").warn(
			`unfinished-memory distillation failed for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
}

/**
 * Read the unfinished todo items of one agent's session.
 * @param ctx - owning context (sessionProjections resolved lazily through
 * the global service registry — property access would hit the fiber
 * topology and silently miss the sibling service).
 * @param agent - the agent whose session to read.
 * @returns the unfinished items, or undefined when the projection is absent.
 */
export function unfinishedTodosOf(
	ctx: Context,
	agent: Agent,
): TodoItemLike[] | undefined {
	const projections = (ctx as unknown as { get(name: string): unknown }).get("sessionProjections") as
		| { snapshot(session: unknown): { values: Record<string, unknown> } }
		| undefined;
	const values = projections?.snapshot(agent.session)?.values;
	const todos = values?.["todos"];
	if (!Array.isArray(todos)) return undefined;
	return todos.filter(
		(item): item is TodoItemLike =>
			typeof item === "object" && item !== null
			&& typeof (item as TodoItemLike).content === "string"
			&& ((item as TodoItemLike).status === "pending" || (item as TodoItemLike).status === "in_progress"),
	);
}

/**
 * One continuation check: goal active → official driver owns it (no-op);
 * no unfinished todos → reset the counter (no-op); cap reached → distill a
 * memory entry (no follow-up); otherwise send one bounded follow-up.
 * @param ctx - owning context.
 * @param engine - the evolution engine (for the cap distillation).
 * @param agent - the idle agent to continue.
 * @param maxRounds - the per-set continuation cap.
 * @param state - per-session continuation counter (mutated).
 * @returns true when a continuation message was sent.
 */
export function checkAndContinue(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	maxRounds: number,
	state: ContinueState,
): boolean {
	// An active goal drives rounds through the official goal round driver —
	// the hook must not double-drive the same session.
	if (goalServiceOf(ctx)?.get(agent)?.phase === "active") {
		return false;
	}
	const unfinished = unfinishedTodosOf(ctx, agent);
	if (unfinished === undefined || unfinished.length === 0) {
		state.rounds = 0;
		return false;
	}
	if (state.rounds >= maxRounds) {
		ctx.logger("continual-evolve").info(
			`unfinished continuation cap reached for ${agent.id} (${maxRounds} rounds); distilling ${unfinished.length} unfinished items into local memory`,
		);
		distillUnfinishedMemory(ctx, engine, agent, unfinished);
		return false;
	}
	state.rounds += 1;
	agent.followup(createUserMessage({
		content: [{ type: "text", text: continueMessageText(unfinished) }],
		source: { kind: "user" },
	}));
	return true;
}
