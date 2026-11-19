import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	finishInquiry,
	GRACE_MS,
	PROGRESS_TYPE,
	type Reply,
	type Subagent,
	startInquiry,
	withProgress,
} from "../extensions/fork-task/subagent-progress.ts";

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
});
