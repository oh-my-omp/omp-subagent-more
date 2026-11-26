import { describe, expect, test } from "bun:test";
import type { Json } from "../extensions/flow/defs.ts";
import { viewOf } from "../extensions/flow/project.ts";
import { definitionKey, modelKey, type Outcome } from "../extensions/flow/state.ts";
import { Store } from "../extensions/flow/store.ts";

const HANDOFF: Json = { did: "work", decided: [], unverified: [] };
const done = (value: Json, handoff: Json = HANDOFF): Outcome => ({ kind: "done", value, handoff });
const OUT: Json = { type: "object" };
const ASK: Json = { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.slices[]" }, out: OUT, raises: ["question"] };
const ANSWER: Json = { agent: "task:low", brief: "Answer {{raise}}", in: { raise: "work!question" }, out: OUT };
const SINGLE = { agent: "task:low", brief: "Do {{issue}}", in: { issue: "input.issue" }, out: OUT } satisfies Json;

function open(): Store {
	const store = new Store([], () => {});
	store.observe({ [definitionKey("task:low")]: "low-1", [modelKey("task:low")]: "cheap" });
	return store;
}

function raising(boxes: Readonly<Record<string, Json>>): Store {
	const flow = open();
	flow.submit({ kind: "define", boxes });
	flow.submit({ kind: "supply", name: "slices", value: ["a", "b"] });
	flow.submit({ kind: "run" });
	flow.advance();
	flow.settle("work#1", 1, { kind: "raise", type: "question", detail: "which?", handoff: HANDOFF });
	return flow;
}

describe("the flow view", () => {
	test("a raise no box answers is shown, a raise a box handles is not", () => {
		const alone = raising({ work: ASK });
		expect(viewOf(alone.state, alone.survey(), []).attention).toEqual([
			{ kind: "raise", key: "work#1", type: "question", detail: "which?" },
		]);

		const handled = raising({ work: ASK, answer: ANSWER });
		expect(viewOf(handled.state, handled.survey(), []).attention).toEqual([]);
	});

	test("waiting splits follow raises and a stop cause comes last", () => {
		const flow = raising({ work: ASK });
		flow.submit({ kind: "stop", reason: "enough" });
		const view = viewOf(flow.state, flow.survey(), [{ key: "work#1", session: "Flowwork_1", parts: ["a", { n: 1 }] }]);
		expect(view.attention).toEqual([
			{ kind: "raise", key: "work#1", type: "question", detail: "which?" },
			{ kind: "split", key: "work#1", session: "Flowwork_1", parts: ["a", '{"n":1}'] },
			{ kind: "stopped", cause: { kind: "halt", reason: "enough" } },
		]);
	});

	test("a handoff in the yield shape is parsed, none is empty, anything else stays raw", () => {
		const flow = open();
		flow.submit({ kind: "define", boxes: { work: ASK } });
		flow.submit({ kind: "supply", name: "slices", value: ["a", "b", "c", "d"] });
		flow.submit({ kind: "run" });
		flow.advance();
		flow.settle("work#0", 1, done("first", { did: "did it", decided: ["x"], unverified: ["y"] }));
		flow.settle("work#3", 1, done("fourth", null));
		flow.settle("work#1", 1, done("second", "just prose"));
		flow.settle("work#2", 1, done("third", { did: "only this" }));
		expect(viewOf(flow.state, flow.survey(), []).units.map((unit) => unit.phase)).toEqual([
			{ kind: "done", handoff: { kind: "parsed", did: "did it", decided: ["x"], unverified: ["y"] } },
			{ kind: "done", handoff: { kind: "raw", text: "just prose" } },
			{ kind: "done", handoff: { kind: "raw", text: '{\n "did": "only this"\n}' } },
			{ kind: "done", handoff: { kind: "none" } },
		]);
	});

	test("idle is complete once every item is done, and not while an item is raised", () => {
		const stuck = raising({ work: ASK });
		stuck.settle("work#0", 1, done(1));
		stuck.advance();
		expect(stuck.state.mode.kind).toBe("idle");
		expect(viewOf(stuck.state, stuck.survey(), []).mode).toEqual({ kind: "idle", complete: false });

		const finished = open();
		finished.submit({ kind: "define", boxes: { work: SINGLE } });
		finished.submit({ kind: "supply", name: "issue", value: "#1" });
		finished.submit({ kind: "run" });
		finished.advance();
		finished.settle("work", 1, done(1));
		finished.advance();
		expect(viewOf(finished.state, finished.survey(), []).mode).toEqual({ kind: "idle", complete: true });
	});

	test("redefining a box makes the item it produced earlier stale", () => {
		const work = { ...SINGLE };
		const flow = open();
		flow.submit({ kind: "define", boxes: { work } });
		flow.submit({ kind: "supply", name: "issue", value: "#1" });
		flow.submit({ kind: "run" });
		flow.advance();
		flow.settle("work", 1, done(1));
		expect(viewOf(flow.state, flow.survey(), []).units[0]?.freshness).toBe("current");

		flow.submit({ kind: "define", boxes: { work: { ...work, brief: "Instead {{issue}}" } } });
		expect(viewOf(flow.state, flow.survey(), []).units[0]?.freshness).toBe("stale");
	});
});
