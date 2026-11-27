import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import {
	finishInquiry,
	GRACE_MS,
	PROGRESS_TYPE,
	type Reply,
	registerSubagentProgress,
	type Subagent,
	startInquiry,
	withProgress,
} from "../extensions/fork-task/subagent-progress.ts";
import { type FileOpsPruneReport, getSharedCompactCoordinator } from "../omomp-shared/compact-handoff.ts";

type Probe = {
	readonly subagent: Subagent;
	readonly reply: (text?: string) => void;
	readonly fail: (error: Error) => void;
	readonly signal: () => AbortSignal | undefined;
};

function probe(id: string): Probe {
	const answer = Promise.withResolvers<string>();
	let seen: AbortSignal | undefined;
	return {
		subagent: {
			id,
			ask: (signal) => {
				seen = signal;
				return answer.promise;
			},
		},
		reply: (text = `${id} report`) => answer.resolve(text),
		fail: (error) => answer.reject(error),
		signal: () => seen,
	};
}

type Tracked = { readonly promise: Promise<Reply[]>; readonly settled: () => boolean };

function track(promise: Promise<Reply[]>): Tracked {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	return { promise, settled: () => done };
}

async function flush(): Promise<void> {
	for (let round = 0; round < 5; round++) await Promise.resolve();
}

describe("subagent progress collection", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("replies that arrived before the summary return at once, in subagent order", async () => {
		const a = probe("A");
		const b = probe("B");
		const inquiry = startInquiry([b.subagent, a.subagent]);
		a.reply();
		b.reply();
		const finished = track(finishInquiry(inquiry, GRACE_MS));
		await flush();
		expect(finished.settled()).toBe(true);
		expect(await finished.promise).toEqual([
			{ id: "B", text: "B report" },
			{ id: "A", text: "A report" },
		]);
	});

	test("the collection waits for a slow reply and keeps it when it lands inside the grace", async () => {
		const slow = probe("Slow");
		const finished = track(finishInquiry(startInquiry([slow.subagent]), GRACE_MS));
		vi.advanceTimersByTime(GRACE_MS - 1);
		await flush();
		expect(finished.settled()).toBe(false);
		slow.reply();
		expect(await finished.promise).toEqual([{ id: "Slow", text: "Slow report" }]);
		expect(slow.signal()?.aborted).toBe(true);
	});

	test("a subagent still silent when the grace ends is aborted and left out", async () => {
		const quick = probe("Quick");
		const stuck = probe("Stuck");
		const finished = track(finishInquiry(startInquiry([quick.subagent, stuck.subagent]), GRACE_MS));
		quick.reply();
		await flush();
		expect(finished.settled()).toBe(false);
		vi.advanceTimersByTime(GRACE_MS);
		expect(await finished.promise).toEqual([{ id: "Quick", text: "Quick report" }]);
		expect(stuck.signal()?.aborted).toBe(true);
		stuck.reply("too late");
		await flush();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("no reply within the grace yields nothing to inject", async () => {
		const stuck = probe("Stuck");
		const finished = finishInquiry(startInquiry([stuck.subagent]), GRACE_MS);
		vi.advanceTimersByTime(GRACE_MS);
		expect(await finished).toEqual([]);
	});

	test("a failed ask and a blank reply are left out", async () => {
		const broken = probe("Broken");
		const blank = probe("Blank");
		const ok = probe("Ok");
		const inquiry = startInquiry([broken.subagent, blank.subagent, ok.subagent]);
		broken.fail(new Error("Active model changed during ephemeral turn; retry."));
		blank.reply("  \n ");
		ok.reply();
		expect(await finishInquiry(inquiry, GRACE_MS)).toEqual([{ id: "Ok", text: "Ok report" }]);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("subagent progress placement", () => {
	const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
	const summary = (text: string, timestamp: number): AgentMessage => ({
		role: "compactionSummary",
		summary: text,
		tokensBefore: 10,
		timestamp,
	});

	test("the block sits right after the latest compaction summary", () => {
		const placed = withProgress([summary("old", 1), user("a"), summary("new", 2), user("b")], "<subagent-progress>x</subagent-progress>");
		expect(placed.map((message) => message.role)).toEqual(["compactionSummary", "user", "compactionSummary", "custom", "user"]);
		const block = placed[3];
		expect(block?.role === "custom" && block.customType === PROGRESS_TYPE ? block.content : undefined).toBe(
			"<subagent-progress>x</subagent-progress>",
		);
	});

	test("splices after the assistant + toolResult fold boundary for anthropicCompaction summaries", () => {
		const anthropicSummary = {
			...summary("native", 2),
			providerPayload: { type: "anthropicCompaction", content: "opaque" },
		} as unknown as AgentMessage;
		const assistantTurn = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 3,
		} as unknown as AgentMessage;
		const toolResult = (toolCallId: string, timestamp: number): AgentMessage =>
			({
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp,
			}) as unknown as AgentMessage;

		const placed = withProgress(
			[summary("old", 1), user("a"), anthropicSummary, assistantTurn, toolResult("call-1", 4), toolResult("call-2", 5), user("b")],
			"<subagent-progress>fold-safe</subagent-progress>",
		);
		expect(placed.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"compactionSummary",
			"assistant",
			"toolResult",
			"toolResult",
			"custom",
			"user",
		]);
		const block = placed[6];
		expect(block?.role === "custom" && block.customType === PROGRESS_TYPE ? block.content : undefined).toBe(
			"<subagent-progress>fold-safe</subagent-progress>",
		);
	});
});

const EMPTY_PRUNE_REPORT: FileOpsPruneReport = {
	totalInputPaths: 0,
	strippedQueryCount: 0,
	filteredNoiseCount: 0,
	keptUniqueCandidateCount: 0,
	selectedCount: 0,
	repoSourcePathsSelected: [],
	selectedPaths: [],
};

describe("registerSubagentProgress compact handoff", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function createMockPi(): ExtensionAPI {
		return {
			on: () => {},
			events: {},
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		} as unknown as ExtensionAPI;
	}

	test("registers omp-subagent-ng in the shared compact coordinator and emits an empty-state claim when no live subagents exist", () => {
		const coordinator = getSharedCompactCoordinator();
		registerSubagentProgress(createMockPi(), () => {});
		expect(coordinator.listPluginIds()).toContain("omp-subagent-ng");

		const snapshot = coordinator.prepareSnapshot(
			{
				cwd: "/repo",
				branchEntries: [],
				messagesToSummarize: [],
				extensionCtx: {
					agent: { id: "root-agent" },
					sessionManager: { getSessionFile: () => undefined },
				} as unknown as ExtensionContext,
			},
			EMPTY_PRUNE_REPORT,
		);

		expect(snapshot.inactiveStatefulPluginIds).toContain("omp-subagent-ng");
		expect(snapshot.activeHandoffs.some((h) => h.pluginId === "omp-subagent-ng")).toBe(false);
		const emptyClaimLine = snapshot.compactingResult.context?.find((line) => line.startsWith("harness-provided [omp-subagent-ng]"));
		expect(emptyClaimLine).toBeDefined();
		expect(emptyClaimLine).toContain("zero in-flight subagents");
		expect(emptyClaimLine).not.toContain("\n");
	});

	test("captures live subagents and emits a plugin-managed claim + injection spec", () => {
		const coordinator = getSharedCompactCoordinator();
		registerSubagentProgress(createMockPi(), () => {});

		const mockSession = {
			activeToolExecutionUpdates: () => [],
			runEphemeralTurn: async () => ({ replyText: "working" }),
		} as unknown as AgentSessionHandle;

		AgentRegistry.global().register({
			id: "Worker-1",
			displayName: "Worker-1",
			kind: "sub",
			parentId: "root-agent",
			status: "running",
			session: mockSession,
			sessionFile: null,
		});

		const snapshot = coordinator.prepareSnapshot(
			{
				cwd: "/repo",
				branchEntries: [],
				messagesToSummarize: [],
				extensionCtx: {
					agent: { id: "root-agent" },
					sessionManager: { getSessionFile: () => undefined },
				} as unknown as ExtensionContext,
			},
			EMPTY_PRUNE_REPORT,
		);

		const handoff = snapshot.activeHandoffs.find((h) => h.pluginId === "omp-subagent-ng");
		expect(handoff).toBeDefined();
		expect(handoff?.claim).toContain("Worker-1");
		expect(handoff?.claim).toContain("<subagent-progress>");
		expect(handoff?.injection).toEqual({ source: PROGRESS_TYPE, delivery: "plugin-managed" });
	});
});
