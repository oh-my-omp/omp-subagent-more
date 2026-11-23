import { z } from "@oh-my-pi/omptype/zod";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";
import { type AgentRef, AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { sessionFileBelongsToRoot } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { isAgentViewSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import {
	computeSafePostCompactInsertIndex,
	defineStatefulHarnessHandoff,
	registerCompactHandoff,
} from "../../omomp-shared/compact-handoff.ts";
import { callerSession } from "./caller-session.ts";

export const PROGRESS_TYPE = "omp-subagent-more.subagent-progress";
export const GRACE_MS = 10_000;

const QUESTION = [
	"<btw>",
	"Ephemeral side question from the agent that dispatched you: its context is being compacted.",
	"Answer briefly, directly; use conversation context already provided.",
	"NEVER use tools.",
	"NEVER ask follow-up questions.",
	"Question:",
	"In at most five short lines: what are you responsible for, what is your goal, and how are you doing it (approach and where you stand now)?",
	"</btw>",
].join("\n");

const recordSchema = z.object({ compactionId: z.string(), text: z.string() });

export type Subagent = { readonly id: string; ask(signal: AbortSignal): Promise<string> };

export type Reply = { readonly id: string; readonly text: string };

export type Inquiry = {
	readonly order: readonly string[];
	readonly replies: Map<string, string>;
	readonly controller: AbortController;
	readonly settled: Promise<void>;
};

export function startInquiry(subagents: readonly Subagent[]): Inquiry {
	const controller = new AbortController();
	const replies = new Map<string, string>();
	const asks = subagents.map(async (subagent) => {
		const text = (await subagent.ask(controller.signal)).trim();
		if (text !== "" && !controller.signal.aborted) replies.set(subagent.id, text);
	});
	return {
		order: subagents.map((subagent) => subagent.id),
		replies,
		controller,
		settled: Promise.allSettled(asks).then(() => undefined),
	};
}

export async function finishInquiry(inquiry: Inquiry, graceMs: number): Promise<Reply[]> {
	const grace = Promise.withResolvers<void>();
	const timer = setTimeout(grace.resolve, graceMs);
	try {
		await Promise.race([inquiry.settled, grace.promise]);
	} finally {
		clearTimeout(timer);
		inquiry.controller.abort();
	}
	return inquiry.order.flatMap((id) => {
		const text = inquiry.replies.get(id);
		return text === undefined ? [] : [{ id, text }];
	});
}

export function renderProgress(replies: readonly Reply[], compactedAt: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	const clock = `${pad(compactedAt.getHours())}:${pad(compactedAt.getMinutes())}`;
	return [
		"<subagent-progress>",
		`Asked when this context was compacted (${clock}): each subagent's own account of what it is responsible for, its goal, and how it is doing it. They may have moved on since.`,
		...replies.flatMap((reply) => ["", `### ${reply.id}`, reply.text]),
		"</subagent-progress>",
	].join("\n");
}

function descendsFrom(registry: AgentRegistryApi, ref: AgentRef, rootId: string): boolean {
	const seen = new Set<string>();
	let parent = ref.parentId;
	while (parent !== undefined && !seen.has(parent)) {
		if (parent === rootId) return true;
		seen.add(parent);
		parent = registry.get(parent)?.parentId;
	}
	return false;
}

function liveSubagents(rootId: string, rootFile: string | undefined): Subagent[] {
	const registry = AgentRegistry.global();
	return registry.list().flatMap((ref) => {
		const session = ref.session;
		if (ref.kind !== "sub" || (ref.status !== "running" && ref.status !== "idle")) return [];
		if (session === null || !isAgentViewSession(session) || !descendsFrom(registry, ref, rootId)) return [];
		if (rootFile !== undefined && (ref.sessionFile === null || !sessionFileBelongsToRoot(ref.sessionFile, rootFile))) return [];
		return [
			{
				id: ref.id,
				ask: async (signal: AbortSignal) =>
					(
						await session.runEphemeralTurn({
							promptText: QUESTION,
							tools: false,
							minimizeEffort: true,
							purpose: "subagent-progress",
							signal,
						})
					).replyText,
			},
		];
	});
}

function recordedProgress(manager: ReadonlySessionManager, compactedAt: number): string | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "compaction") continue;
		if (Date.parse(entry.timestamp) !== compactedAt) return undefined;
		for (const later of branch.slice(index + 1)) {
			if (later.type !== "custom" || later.customType !== PROGRESS_TYPE) continue;
			const record = recordSchema.safeParse(later.data);
			if (record.success && record.data.compactionId === entry.id) return record.data.text;
		}
		return undefined;
	}
	return undefined;
}

export function withProgress(messages: readonly AgentMessage[], text: string): AgentMessage[] {
	const at = computeSafePostCompactInsertIndex(messages);
	const payload: AgentMessage = {
		role: "custom",
		customType: PROGRESS_TYPE,
		content: text,
		display: false,
		attribution: "agent",
		timestamp: 0,
	};
	return [...messages.slice(0, at), payload, ...messages.slice(at)];
}

type Running = { readonly inquiry: Inquiry; readonly stop: () => void };

type SessionState = {
	running: Running | undefined;
	progress: { readonly compactedAt: number; readonly text: Promise<string | undefined> } | undefined;
};

export function registerSubagentProgress(pi: ExtensionAPI, warn: (message: string, error: unknown) => void): void {
	const states = new WeakMap<ReadonlySessionManager, SessionState>();
	const stateOf = (manager: ReadonlySessionManager): SessionState => {
		const existing = states.get(manager);
		if (existing) return existing;
		const created: SessionState = { running: undefined, progress: undefined };
		states.set(manager, created);
		return created;
	};

	registerCompactHandoff(
		pi,
		defineStatefulHarnessHandoff<{ readonly subagentIds: readonly string[] }>({
			pluginId: "omp-subagent-ng",
			captureState(compactCtx) {
				const extCtx = compactCtx.extensionCtx;
				const subagents = extCtx ? liveSubagents(extCtx.agent.id, extCtx.sessionManager.getSessionFile()) : [];
				const running = extCtx ? stateOf(extCtx.sessionManager).running : undefined;
				if (subagents.length === 0 && running === undefined) return null;
				return {
					subagentIds: subagents.length > 0 ? subagents.map((s) => s.id) : [...(running?.inquiry.order ?? [])],
				};
			},
			renderCompactPromptClaim(s) {
				return `\`omp-subagent-ng\` (\`<subagent-progress>\`) is querying live subagents (${s.subagentIds.join(", ")}) out-of-band during compaction and will splice their live progress block and \`agent://\`/\`history://\` handles right after the compaction boundary — NEVER write prose subagent inventories or status tables.`;
			},
			renderPostCompactInjection() {
				return { source: PROGRESS_TYPE, delivery: "plugin-managed" };
			},
		}),
	);

	pi.on("session.compacting", (_event, ctx) => {
		const state = stateOf(ctx.sessionManager);
		state.running?.stop();
		const subagents = liveSubagents(ctx.agent.id, ctx.sessionManager.getSessionFile());
		if (subagents.length === 0) return undefined;
		const inquiry = startInquiry(
			subagents.map((subagent) => ({
				id: subagent.id,
				ask: async (signal: AbortSignal) => {
					const text = await subagent.ask(signal);
					pi.logger.info("omp-subagent-ng subagent answered", { id: subagent.id, at: new Date().toISOString() });
					return text;
				},
			})),
		);
		let unsubscribe: (() => void) | undefined;
		const running: Running = {
			inquiry,
			stop: () => {
				inquiry.controller.abort();
				unsubscribe?.();
				if (state.running === running) state.running = undefined;
			},
		};
		state.running = running;
		unsubscribe = callerSession(ctx)?.subscribe((event) => {
			if ((event.type === "manual_compaction_end" || event.type === "auto_compaction_end") && event.result === undefined) running.stop();
		});
		pi.logger.info("omp-subagent-ng asked subagents for progress", { subagents: inquiry.order });
		return undefined;
	});

	pi.on("session_compact", (event, ctx) => {
		const state = stateOf(ctx.sessionManager);
		const running = state.running;
		if (running === undefined) return;
		if (event.fromExtension) {
			running.stop();
			return;
		}
		state.running = undefined;
		const entry = event.compactionEntry;
		const compactedAt = Date.parse(entry.timestamp);
		pi.logger.info("omp-subagent-ng summary returned", { compactionId: entry.id, at: new Date().toISOString() });
		const text = finishInquiry(running.inquiry, GRACE_MS)
			.then((replies) => {
				running.stop();
				pi.logger.info("omp-subagent-ng subagent progress collected", {
					compactionId: entry.id,
					answered: replies.map((reply) => reply.id),
					abandoned: running.inquiry.order.filter((id) => !replies.some((reply) => reply.id === id)),
				});
				if (replies.length === 0) return undefined;
				const rendered = renderProgress(replies, new Date(compactedAt));
				pi.appendEntry(PROGRESS_TYPE, { compactionId: entry.id, text: rendered });
				return rendered;
			})
			.catch((error: unknown) => {
				running.stop();
				warn("omp-subagent-ng could not record subagent progress", error);
				return undefined;
			});
		state.progress = { compactedAt, text };
	});

	pi.on("context", async (event, ctx) => {
		try {
			const summary = event.messages.findLast((message) => message.role === "compactionSummary");
			if (summary === undefined) return undefined;
			const state = stateOf(ctx.sessionManager);
			if (state.progress?.compactedAt !== summary.timestamp) {
				state.progress = { compactedAt: summary.timestamp, text: Promise.resolve(recordedProgress(ctx.sessionManager, summary.timestamp)) };
			}
			const text = await state.progress.text;
			return text === undefined ? undefined : { messages: withProgress(event.messages, text) };
		} catch (error) {
			warn("omp-subagent-ng could not attach subagent progress", error);
			return undefined;
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stateOf(ctx.sessionManager).running?.stop();
	});
}
