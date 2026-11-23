import { describe, expect, test } from "bun:test";
import { askSplit, type SplitAnswer, type SplitAsk, serveSplits } from "../extensions/flow/split.ts";

describe("a split request blocks until the author of the claiming flow decides", () => {
	test("only the flow that knows the session answers, and `waiting` keeps the request blocked until the decision", async () => {
		const claimed = Promise.withResolvers<{ readonly ask: SplitAsk; readonly answer: (reply: SplitAnswer) => void }>();
		const stranger = serveSplits(() => false);
		const owner = serveSplits((ask, answer) => {
			if (ask.session !== "Flowwork_0") return false;
			answer({ kind: "waiting" });
			claimed.resolve({ ask, answer });
			return true;
		});
		try {
			const pending = askSplit({ session: "Flowwork_0", parts: ['"a"', '"b"'], details: "two functions" }, undefined);
			const { ask, answer } = await claimed.promise;
			expect(ask).toMatchObject({ session: "Flowwork_0", parts: ['"a"', '"b"'], details: "two functions" });
			answer({ kind: "disagreed", reason: "one piece per file" });
			expect(await pending).toEqual({ kind: "disagreed", reason: "one piece per file" });
		} finally {
			stranger.close();
			owner.close();
		}
	});

	test("cancelling the call ends the wait", async () => {
		const owner = serveSplits((_ask, reply) => {
			reply({ kind: "waiting" });
			return true;
		});
		try {
			const abort = new AbortController();
			const pending = askSplit({ session: "Flowwork_0", parts: ['"a"', '"b"'], details: "two" }, abort.signal);
			abort.abort(new Error("cancelled"));
			await expect(pending).rejects.toThrow("cancelled");
		} finally {
			owner.close();
		}
	});
});
