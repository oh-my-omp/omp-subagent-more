import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fill, type Json, shellWord } from "../prototype/flow/defs.ts";
import { appendLog, readLog } from "../prototype/flow/journal.ts";
import type { Firing } from "../prototype/flow/plan.ts";
import { briefOf, interpret, yieldSchema } from "../prototype/flow/session.ts";
import { type Action, definitionKey, modelKey, type Outcome, replay } from "../prototype/flow/state.ts";
import { moves, Store } from "../prototype/flow/store.ts";

const HANDOFF: Json = { did: "work", decided: [], unverified: [] };
const done = (value: Json): Outcome => ({ kind: "done", value, handoff: HANDOFF });
const failed = (name: string): Outcome => ({ kind: "failed", name, reason: `${name} happened` });

const OUT: Json = { type: "object" };
const SCOUT: Json = { agent: "task:low", brief: "Slice {{issue}}", in: { issue: "input.issue" }, out: OUT };
const WORK: Json = { agent: "task:low", brief: "Do {{slice}}", in: { slice: "scout.slices[]" }, out: OUT };
const GATE: Json = { command: "check {{results}}", in: { results: "work" } };

const agent = (name: string, definition: string, model: string): Record<string, string> => ({
	[definitionKey(name)]: definition,
	[modelKey(name)]: model,
});

function open(log: Action[] = []) {
	const store = new Store(log, (action) => log.push(action));
	store.observe({ ...agent("task:low", "low-1", "cheap"), ...agent("task:mid", "mid-1", "middle") });
	const keys = (firings: readonly Firing[]): string[] => firings.map((firing) => `${firing.key}@${firing.attempt}`);
	return { store, log, keys, fire: () => keys(store.advance()) };
}

function fanned() {
	const flow = open();
	flow.store.submit({ kind: "define", boxes: { scout: SCOUT, work: WORK, gate: GATE } });
	flow.store.submit({ kind: "supply", name: "issue", value: "#1" });
	flow.store.submit({ kind: "run" });
	flow.fire();
	flow.store.settle("scout", 1, done({ slices: ["a", "b"] }));
	flow.fire();
	return flow;
}

describe("scheduling", () => {
	test("a box fires once its inputs have values, and one item per element of a `[]` input", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { scout: SCOUT, work: WORK, gate: GATE } });
		flow.store.submit({ kind: "run" });
		expect(flow.fire()).toEqual([]);
		expect(flow.store.survey().needs).toEqual(["issue"]);

		flow.store.submit({ kind: "supply", name: "issue", value: "#1" });
		flow.store.submit({ kind: "run" });
		expect(flow.fire()).toEqual(["scout@1"]);
		flow.store.settle("scout", 1, done({ slices: ["a", "b"] }));
		const firings = flow.store.advance();
		expect(firings.map((firing) => [firing.key, firing.inputs.slice])).toEqual([
			["work#0", "a"],
			["work#1", "b"],
		]);

		flow.store.settle("work#0", 1, done({ n: 0 }));
		expect(flow.fire()).toEqual([]);
		flow.store.settle("work#1", 1, done({ n: 1 }));
		const gate = flow.store.advance();
		expect(gate.map((firing) => [firing.key, firing.inputs.results])).toEqual([["gate", [{ n: 0 }, { n: 1 }]]]);
		flow.store.settle("gate", 1, done("ok"));
		flow.fire();
		expect(flow.store.state.mode.kind).toBe("idle");
		expect(flow.store.everything()[0]).toStartWith("flow complete");
	});

	test("`limit` bounds how many items of a box are in flight", () => {
		const flow = open();
		flow.store.submit({
			kind: "define",
			boxes: { work: { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.slices[]" }, out: OUT, limit: 1 } },
		});
		flow.store.submit({ kind: "supply", name: "slices", value: ["a", "b", "c"] });
		flow.store.submit({ kind: "run" });
		expect(flow.fire()).toEqual(["work#0@1"]);
		expect(flow.fire()).toEqual([]);
		flow.store.settle("work#0", 1, done(1));
		expect(flow.fire()).toEqual(["work#1@1"]);
	});

	test("the state is the fold of the log and nothing else", () => {
		const flow = fanned();
		flow.store.settle("work#0", 1, done({ n: 0 }));
		flow.store.settle("work#1", 1, failed("timeout"));
		const rebuilt = new Store(flow.log, () => {});
		expect(rebuilt.state).toEqual(flow.store.state);
		expect(replay(flow.log)).toEqual(flow.store.state);
		expect(rebuilt.everything()).toEqual(flow.store.everything());
	});

	test("after a restart no session of the earlier process is alive: running items end cancelled and fire again on resume", () => {
		const flow = fanned();
		const next = open(flow.log);
		next.store.recover();
		expect(next.store.state.mode.kind).toBe("stopped");
		expect(next.store.submit({ kind: "run" }).accepted).toBe(true);
		expect(next.fire()).toEqual(["work#0@2", "work#1@2"]);
	});
});

describe("sessions of one item", () => {
	test("a new session of an item is told which session of that item ended last, and whether it ended by yielding", () => {
		const flow = open();
		flow.store.submit({
			kind: "define",
			boxes: { work: { agent: "task:low", brief: "x", out: OUT, raises: ["question"], handle: { session: 1, spawn: 1 } } },
		});
		flow.store.submit({ kind: "run" });
		expect(flow.store.advance().map((firing) => firing.earlier)).toEqual([undefined]);

		flow.store.spawned("work", 1, "A");
		flow.store.settle("work", 1, failed("session"));
		expect(flow.store.advance().map((firing) => firing.earlier)).toEqual([{ session: "A", yielded: false }]);

		flow.store.settle("work", 2, failed("spawn"));
		expect(flow.store.advance().map((firing) => firing.earlier)).toEqual([{ session: "A", yielded: false }]);

		flow.store.spawned("work", 3, "C");
		flow.store.settle("work", 3, { kind: "raise", type: "question", detail: "?", handoff: HANDOFF });
		flow.store.submit({ kind: "answer", key: "work", value: "yes" });
		expect(flow.store.advance().map((firing) => firing.earlier)).toEqual([{ session: "C", yielded: true }]);
	});

	test("an item produced again after a retract starts from nothing", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { work: { agent: "task:low", brief: "x", out: OUT } } });
		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.spawned("work", 1, "A");
		flow.store.settle("work", 1, failed("session"));
		flow.store.submit({ kind: "retract", keys: ["work"] });
		flow.store.submit({ kind: "run" });
		expect(flow.store.advance().map((firing) => [firing.attempt, firing.earlier])).toEqual([[1, undefined]]);
	});
});

describe("runtime exceptions", () => {
	test("one the box does not handle stops the whole flow, and sessions still running are no longer waited for", () => {
		const flow = fanned();
		flow.store.settle("work#1", 1, failed("timeout"));
		expect(flow.store.state.mode).toEqual({
			kind: "stopped",
			cause: { kind: "exception", key: "work#1", name: "timeout", reason: "timeout happened" },
		});
		expect(flow.fire()).toEqual([]);
		expect(flow.store.orphans([{ key: "work#0", attempt: 1 }])).toEqual([{ key: "work#0", attempt: 1 }]);
	});

	test("a stopped flow resumes only after the exception is handled", () => {
		const flow = fanned();
		flow.store.settle("work#1", 1, failed("timeout"));
		flow.store.settle("work#0", 1, { kind: "cancelled" });

		const refused = flow.store.submit({ kind: "run" });
		expect(refused.accepted).toBe(false);
		expect(refused.refusals.join("\n")).toContain("work#1: failed with `timeout`");
		expect(flow.store.state.mode.kind).toBe("stopped");

		expect(flow.store.submit({ kind: "retry", keys: ["work#1"] }).accepted).toBe(true);
		expect(flow.store.submit({ kind: "run" }).accepted).toBe(true);
		expect(flow.fire()).toEqual(["work#0@2", "work#1@2"]);
	});

	test("replacing the failed box's definition handles the exception; values of other boxes stand", () => {
		const flow = fanned();
		flow.store.settle("work#0", 1, done({ n: 0 }));
		flow.store.settle("work#1", 1, failed("timeout"));
		flow.store.submit({
			kind: "define",
			boxes: { work: { agent: "task:mid", brief: "Do {{slice}}", in: { slice: "scout.slices[]" }, out: OUT } },
		});

		const refused = flow.store.submit({ kind: "run" });
		expect(refused.refusals).toHaveLength(1);
		expect(refused.refusals[0]).toStartWith("work#0: produced under an earlier definition");
		expect(flow.store.survey().stale).toEqual(["work#0"]);

		flow.store.submit({ kind: "keep", keys: ["work#0"] });
		expect(flow.store.submit({ kind: "run" }).accepted).toBe(true);
		expect(flow.fire()).toEqual(["work#1@2"]);
		expect(flow.store.state.items.scout?.attempt).toBe(1);
	});

	test("a named exception the box handles fires the item again, as many times as declared, without stopping", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { gate: { command: "true", handle: { exit: 1 } } } });
		flow.store.submit({ kind: "run" });
		expect(flow.fire()).toEqual(["gate@1"]);
		flow.store.settle("gate", 1, failed("exit"));
		expect(flow.store.state.mode.kind).toBe("running");
		expect(flow.fire()).toEqual(["gate@2"]);
		flow.store.settle("gate", 2, failed("exit"));
		expect(flow.store.state.mode.kind).toBe("stopped");
	});

	test("each handled exception name has its own count", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { gate: { command: "true", handle: { exit: 1, timeout: 1 } } } });
		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.settle("gate", 1, failed("exit"));
		flow.fire();
		flow.store.settle("gate", 2, failed("timeout"));
		expect(flow.store.state.mode.kind).toBe("running");
		expect(flow.fire()).toEqual(["gate@3"]);
		flow.store.settle("gate", 3, failed("timeout"));
		expect(flow.store.state.mode).toMatchObject({ kind: "stopped", cause: { name: "timeout" } });
	});

	test("a session that outlived its item reports to nothing", () => {
		const flow = fanned();
		flow.store.submit({ kind: "retract", keys: ["work#0"] });
		const before = flow.store.state;
		flow.store.settle("work#0", 1, done({ n: 0 }));
		expect(flow.store.state).toEqual(before);
	});
});

describe("definitions and values", () => {
	test("a definition with problems is refused whole and names every problem", () => {
		const flow = open();
		const verdict = flow.store.submit({
			kind: "define",
			boxes: { ok: GATE, bad: { agent: "task:low", brief: "{{nope}}", prepare: "install {{gone}}", out: OUT, raises: "q", typo: 1 } },
		});
		expect(verdict.accepted).toBe(false);
		expect(verdict.refusals).toEqual([
			"bad: unknown field `typo`",
			"bad: `{{nope}}` names no input of this box",
			"bad: `{{gone}}` names no input of this box",
			"bad: `raises` is an array of names",
		]);
		expect(flow.log.filter((action) => action.kind === "defined")).toEqual([]);
	});

	test("a reference to a box that does not exist keeps the flow from starting; nothing fires", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { work: WORK } });
		const verdict = flow.store.submit({ kind: "run" });
		expect(verdict.refusals).toEqual(["work: in.slice → no box `scout`"]);
		expect(flow.fire()).toEqual([]);
	});

	test("boxes that need each other's results are refused as a cycle", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { a: { command: "a {{x}}", in: { x: "b" } }, b: { command: "b {{x}}", in: { x: "a" } } } });
		expect(flow.store.submit({ kind: "run" }).refusals).toEqual(["cycle: a → b → a"]);
	});

	test("a value produced under an earlier definition of the agent itself is stale, though the box did not change", () => {
		const flow = fanned();
		flow.store.settle("work#0", 1, done(0));
		flow.store.settle("work#1", 1, done(1));
		flow.fire();
		flow.store.observe(agent("task:low", "low-2", "cheap"));
		expect(flow.store.survey().stale).toEqual(["scout", "work#0", "work#1"]);
		expect(flow.store.everything().join("\n")).toContain("work#0: done in session 1 · stale: produced under definition");
	});

	test("a box runs its agent's definition under another agent's model setting; a change of either makes its values stale", () => {
		const flow = open();
		flow.store.observe(agent("worker", "prompt-1", "own"));
		flow.store.submit({
			kind: "define",
			boxes: { a: { agent: "worker", model: "task:low", brief: "x", out: OUT }, b: { agent: "worker", brief: "x", out: OUT } },
		});
		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.settle("a", 1, done(1));
		flow.store.settle("b", 1, done(1));
		flow.fire();

		flow.store.observe(agent("task:low", "low-1", "cheaper"));
		expect(flow.store.survey().stale).toEqual(["a"]);
		flow.store.submit({ kind: "keep", keys: ["a"] });
		flow.store.observe(agent("worker", "prompt-1", "own-2"));
		expect(flow.store.survey().stale).toEqual(["b"]);
		flow.store.observe(agent("worker", "prompt-2", "own-2"));
		expect(flow.store.survey().stale).toEqual(["a", "b"]);
	});

	test("a box whose `model` names an agent that does not exist keeps the flow from starting", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { a: { agent: "task:low", model: "nobody", brief: "x", out: OUT } } });
		expect(flow.store.submit({ kind: "run" }).refusals).toEqual(["a: agent `nobody` has no model setting to use"]);
	});

	test("a box naming an agent that does not exist keeps the flow from starting", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { scout: { agent: "nobody", brief: "x", out: OUT } } });
		expect(flow.store.submit({ kind: "run" }).refusals).toEqual([
			"scout: there is no agent named `nobody`",
			"scout: agent `nobody` has no model setting to use",
		]);
	});

	test("an item of a box that was dropped is illegal until retracted", () => {
		const flow = fanned();
		flow.store.settle("work#0", 1, done(0));
		flow.store.settle("work#1", 1, done(1));
		flow.fire();
		flow.store.settle("gate", 1, done("ok"));
		flow.fire();
		flow.store.submit({ kind: "define", boxes: { gate: null } });
		expect(flow.store.survey().illegal).toEqual(["gate"]);
		expect(flow.store.submit({ kind: "run" }).accepted).toBe(false);
		flow.store.submit({ kind: "retract", keys: ["gate"] });
		expect(flow.store.submit({ kind: "run" }).accepted).toBe(true);
	});

	test("supplying an input again removes everything computed from it, and only that", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { scout: SCOUT, work: WORK, other: { command: "date" } } });
		flow.store.submit({ kind: "supply", name: "issue", value: "#1" });
		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.settle("scout", 1, done({ slices: ["a"] }));
		flow.store.settle("other", 1, done("today"));
		flow.fire();
		flow.store.settle("work#0", 1, done(0));

		flow.store.submit({ kind: "supply", name: "issue", value: "#2" });
		expect(Object.keys(flow.store.state.items)).toEqual(["other"]);
	});

	test("submitting an unchanged definition or value again changes nothing", () => {
		const flow = fanned();
		const length = flow.log.length;
		flow.store.submit({ kind: "define", boxes: { scout: SCOUT, work: WORK, gate: GATE } });
		flow.store.submit({ kind: "supply", name: "issue", value: "#1" });
		expect(flow.log).toHaveLength(length);
	});

	test("a verdict reports what changed since the last one, not the whole state", () => {
		const flow = open();
		const first = flow.store.submit({ kind: "define", boxes: { scout: SCOUT } });
		expect(first.lines.filter((line) => line.startsWith("+ "))).toHaveLength(1);
		const second = flow.store.submit({ kind: "supply", name: "issue", value: "#1" });
		expect(second.lines.filter((line) => /^[+~-] /.test(line))).toEqual(["+ input.issue: supplied (4 characters of JSON)"]);
		expect(flow.store.changes().filter((line) => /^[+~-] /.test(line))).toEqual([]);
	});
});

describe("what follows from the definitions and the state", () => {
	test("the moves open to the caller change with the state, and `run` is offered only when it would be accepted and start something", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { scout: SCOUT, work: WORK, gate: GATE } });
		expect(moves(flow.store.state)).toEqual(["supply issue"]);

		flow.store.submit({ kind: "supply", name: "issue", value: "#1" });
		expect(moves(flow.store.state)).toEqual(["run"]);

		flow.store.submit({ kind: "run" });
		flow.fire();
		expect(moves(flow.store.state)).toEqual(["stop"]);

		flow.store.settle("scout", 1, failed("session"));
		expect(moves(flow.store.state)).toEqual(["retry or retract scout, or define scout again"]);

		flow.store.submit({ kind: "retry", keys: ["scout"] });
		expect(moves(flow.store.state)).toEqual(["run"]);

		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.settle("scout", 2, done({ slices: [] }));
		flow.fire();
		flow.store.settle("gate", 1, done("ok"));
		flow.fire();
		expect(moves(flow.store.state)).toEqual([]);
	});

	test("the full report shows the graph the references imply, including who answers a raise", () => {
		const flow = open();
		flow.store.submit({
			kind: "define",
			boxes: {
				work: { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.slices[]" }, out: OUT, raises: ["question", "blocked"] },
				answer: { agent: "task:mid", brief: "Answer {{raise}}", in: { raise: "work!question" }, out: OUT },
				gate: { command: "check {{results}}", in: { results: "work" }, handle: { exit: 2 } },
			},
		});
		expect(flow.store.everything().filter((line) => line.startsWith("wire "))).toEqual([
			"wire answer ← work!question",
			"wire gate ← work · fires again on exit ×2",
			"wire work ← input.slices[] · raises question → answer · raises blocked → an answer from outside",
		]);
	});
});

describe("checks", () => {
	const CHECKED: Json = { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.slices[]" }, out: OUT, bound: 2 };
	const CHECK: Json = { command: "check {{work}}", in: { work: "work[]" }, checks: "work" };
	const AFTER: Json = { command: "sum {{checks}}", in: { checks: "check" } };
	const reject = (output: string): Outcome => ({ kind: "rejected", output });

	function checking(boxes: Readonly<Record<string, Json>> = { work: CHECKED, check: CHECK, after: AFTER }) {
		const flow = open();
		flow.store.submit({ kind: "define", boxes });
		flow.store.submit({ kind: "supply", name: "slices", value: ["a", "b"] });
		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.settle("work#0", 1, done(0));
		flow.store.settle("work#1", 1, done(1));
		flow.fire();
		return flow;
	}

	test("a check that rejects reopens the item it checks, which continues in a new session with the output", () => {
		const flow = checking();
		flow.store.settle("check#0", 1, done("ok"));
		flow.store.settle("check#1", 1, reject("expected 3, got 2"));
		expect(flow.store.state.mode.kind).toBe("running");

		const again = flow.store.advance();
		expect(again.map((firing) => [firing.key, firing.attempt, firing.inputs.slice])).toEqual([["work#1", 2, "b"]]);
		expect(again[0]?.continuation).toEqual({ kind: "check", check: "check", output: "expected 3, got 2", previous: HANDOFF });
	});

	test("what was computed from the reopened item's result is gone and is produced again from the new one", () => {
		const flow = checking();
		flow.store.settle("check#0", 1, done("ok"));
		flow.store.settle("check#1", 1, reject("no"));
		expect(Object.keys(flow.store.state.items).sort()).toEqual(["check#0", "work#0", "work#1"]);

		flow.fire();
		expect(flow.store.survey().waiting).toEqual(["after", "check"]);
		flow.store.settle("work#1", 2, done(2));
		expect(flow.fire()).toEqual(["check#1@1"]);
		flow.store.settle("check#1", 1, done("ok"));
		const after = flow.store.advance();
		expect(after.map((firing) => [firing.key, firing.inputs.checks])).toEqual([["after", ["ok", "ok"]]]);
	});

	test("reopenings count towards the checked box's `bound`; a rejection of the last allowed session raises `bound_exceeded`", () => {
		const flow = checking();
		flow.store.settle("check#1", 1, reject("no"));
		flow.fire();
		flow.store.settle("work#1", 2, done(2));
		flow.fire();
		flow.store.settle("check#1", 1, reject("still no"));
		expect(flow.store.state.mode).toMatchObject({ kind: "stopped", cause: { kind: "exception", key: "check#1", name: "bound_exceeded" } });
		expect(flow.store.state.items["work#1"]?.phase.kind).toBe("done");
		expect(flow.store.state.items["check#1"]?.phase).toMatchObject({ kind: "failed", reason: expect.stringContaining("still no") });
	});

	test("a check that could not run raises `exit` like any command: `handle.exit` runs it again, and nothing is reopened", () => {
		const flow = checking({ work: CHECKED, check: { ...(CHECK as object), handle: { exit: 1 } } });
		flow.store.settle("check#1", 1, failed("exit"));
		expect(flow.fire()).toEqual(["check#1@2"]);
		flow.store.settle("check#1", 2, failed("exit"));
		expect(flow.store.state.mode).toMatchObject({ kind: "stopped", cause: { kind: "exception", key: "check#1", name: "exit" } });
		expect(flow.store.state.items["work#1"]?.phase).toMatchObject({ kind: "done", value: 1 });
	});

	test("a check of a box with one item reopens that item", () => {
		const flow = open();
		flow.store.submit({
			kind: "define",
			boxes: {
				work: { agent: "task:low", brief: "Do {{issue}}", in: { issue: "input.issue" }, out: OUT },
				check: { command: "check {{files}}", in: { files: "work.files" }, checks: "work" },
			},
		});
		flow.store.submit({ kind: "supply", name: "issue", value: "#1" });
		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.settle("work", 1, done({ files: ["a"] }));
		flow.fire();
		flow.store.settle("check", 1, reject("no"));
		expect(flow.fire()).toEqual(["work@2"]);
	});

	test("a check that could not say which item to reopen is a definition problem", () => {
		const flow = open();
		const problems = (check: Json, work: Json = CHECKED): readonly string[] => {
			flow.store.submit({ kind: "define", boxes: { work, check } });
			return flow.store.survey().problems;
		};
		expect(problems({ command: "check {{work}}", in: { work: "work" }, checks: "work" })).toEqual([
			"check: `work` has many items; take `work[]` as an input so that each item is checked on its own",
		]);
		expect(problems({ command: "check", checks: "work" })).toEqual(["check: checks `work` but takes no input from it"]);
		expect(problems({ command: "check {{work}}", in: { work: "work[]" }, checks: "gone" })).toEqual(["check: checks → no box `gone`"]);
		expect(problems(CHECK, { command: "build" })).toEqual(["check: checks → `work` is a command box; only an agent box can be reopened"]);
		expect(problems(CHECK)).toEqual([]);
	});

	test("the full report says which item a check's rejection reopens", () => {
		const flow = checking();
		expect(flow.store.everything()).toContain("wire check ← work[] · a rejection reopens work");
		flow.store.changes();
		flow.store.settle("check#1", 1, reject("expected 3,\n got 2"));
		expect(flow.store.changes()).toContain("~ work#1: reopened after session 1 by check `check`: expected 3, got 2");
	});

	test("a log with a reopening folds to the same state", () => {
		const flow = checking();
		flow.store.settle("check#1", 1, reject("no"));
		flow.fire();
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-check-")), "flow.jsonl");
		for (const action of flow.log) appendLog(file, action);
		expect(replay(readLog(file))).toEqual(flow.store.state);
	});
});

describe("exceptions raised by a session", () => {
	const ASK: Json = { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.slices[]" }, out: OUT, raises: ["question"] };
	const ANSWER: Json = { agent: "task:mid", brief: "Answer {{raise}}", in: { raise: "work!question" }, out: OUT };

	function raising(boxes: Readonly<Record<string, Json>> = { work: ASK, answer: ANSWER }) {
		const flow = open();
		flow.store.submit({ kind: "define", boxes });
		flow.store.submit({ kind: "supply", name: "slices", value: ["a", "b"] });
		flow.store.submit({ kind: "run" });
		flow.fire();
		return flow;
	}

	test("a raise wired to a box fires that box with the raise, and its result continues the item in a new session", () => {
		const flow = raising();
		flow.store.settle("work#0", 1, done(0));
		flow.store.settle("work#1", 1, { kind: "raise", type: "question", detail: "which one?", handoff: HANDOFF });
		expect(flow.store.state.mode.kind).toBe("running");

		const handler = flow.store.advance();
		expect(handler.map((firing) => firing.key)).toEqual(["answer<work#1@1>"]);
		expect(handler[0]?.inputs.raise).toEqual({ item: "work#1", type: "question", detail: "which one?", handoff: HANDOFF });

		flow.store.settle("answer<work#1@1>", 1, done("the second"));
		const continued = flow.store.advance();
		expect(continued.map((firing) => [firing.key, firing.attempt, firing.inputs.slice])).toEqual([["work#1", 2, "b"]]);
		expect(continued[0]?.continuation).toEqual({ kind: "answer", answer: "the second", previous: HANDOFF });
	});

	test("a raise nothing is wired to waits for an answer from outside while the rest goes on", () => {
		const flow = raising({ work: ASK });
		flow.store.settle("work#1", 1, { kind: "raise", type: "question", detail: "which one?", handoff: HANDOFF });
		expect(flow.fire()).toEqual([]);
		expect(flow.store.survey().raised.map((raise) => raise.key)).toEqual(["work#1"]);

		expect(flow.store.submit({ kind: "answer", key: "work#0", value: "x" }).accepted).toBe(false);
		flow.store.submit({ kind: "answer", key: "work#1", value: "the first" });
		expect(flow.store.advance().map((firing) => [firing.key, firing.attempt, firing.continuation])).toEqual([
			["work#1", 2, { kind: "answer", answer: "the first", previous: HANDOFF }],
		]);
	});

	test("sessions that failed do not count towards `bound`; only answered raises do", () => {
		const flow = raising({
			work: {
				agent: "task:low",
				brief: "Do {{slice}}",
				in: { slice: "input.slices[]" },
				out: OUT,
				raises: ["question"],
				bound: 2,
				handle: { spawn: 2 },
			},
		});
		flow.store.settle("work#0", 1, failed("spawn"));
		flow.fire();
		flow.store.settle("work#0", 2, failed("spawn"));
		flow.fire();
		flow.store.settle("work#0", 3, { kind: "raise", type: "question", detail: "which?", handoff: HANDOFF });
		expect(flow.store.state.items["work#0"]?.phase.kind).toBe("raised");

		flow.store.submit({ kind: "answer", key: "work#0", value: "this" });
		flow.fire();
		flow.store.settle("work#0", 4, { kind: "raise", type: "question", detail: "and now?", handoff: HANDOFF });
		expect(flow.store.state.mode).toMatchObject({ kind: "stopped", cause: { key: "work#0", name: "bound_exceeded" } });
	});

	test("an item that raises in its last allowed session ends as the runtime exception `bound_exceeded`", () => {
		const flow = raising({
			work: { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.slices[]" }, out: OUT, raises: ["question"], bound: 1 },
		});
		flow.store.settle("work#0", 1, { kind: "raise", type: "question", detail: "again?", handoff: HANDOFF });
		expect(flow.store.state.mode).toMatchObject({ kind: "stopped", cause: { key: "work#0", name: "bound_exceeded" } });
	});

	test("an input wired to a type the box does not raise is a definition problem", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { work: { command: "true" }, answer: ANSWER } });
		expect(flow.store.submit({ kind: "run" }).refusals).toEqual(["answer: in.raise → `work` does not raise `question`"]);
	});

	test("two boxes answering the same raise are a definition problem", () => {
		const flow = open();
		flow.store.submit({ kind: "define", boxes: { work: ASK, answer: ANSWER, second: ANSWER } });
		expect(flow.store.submit({ kind: "run" }).refusals).toEqual(["work!question: answered by more than one box (answer, second)"]);
	});
});

describe("command boxes", () => {
	test("an input reaches the command as one word, whatever characters it holds", () => {
		const nasty = 'it\'s "$HOME" `id` $(id) \\ ; rm -rf *\nsecond line';
		const command = fill("printf %s {{text}}", { text: nasty }, shellWord);
		const run = Bun.spawnSync(["sh", "-c", command]);
		expect(run.stdout.toString()).toBe(nasty);
		expect(run.exitCode).toBe(0);
	});
});

describe("the log on disk", () => {
	function eventful(file: string) {
		const log: Action[] = [];
		const store = new Store(log, (action) => {
			log.push(action);
			appendLog(file, action);
		});
		store.observe(agent("task:low", "low-1", "cheap"));
		store.submit({
			kind: "define",
			boxes: {
				work: { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.slices[]" }, out: OUT, raises: ["question"] },
				gate: { command: "true", handle: { exit: 1 } },
				solo: { command: "true" },
			},
		});
		store.submit({ kind: "supply", name: "slices", value: ["a", "b", "c"] });
		store.submit({ kind: "run" });
		store.advance();
		store.settle("solo", 1, done("out"));
		store.spawned("work#0", 1, "FlowWork0");
		store.settle("work#0", 1, done({ n: 0 }));
		store.settle("work#1", 1, { kind: "raise", type: "question", detail: "which?", handoff: HANDOFF });
		store.submit({ kind: "answer", key: "work#1", value: "this" });
		store.advance();
		store.settle("gate", 1, failed("exit"));
		store.settle("work#2", 1, failed("session"));
		store.settle("work#1", 2, { kind: "cancelled" });
		store.submit({ kind: "retry", keys: ["work#2"] });
		store.submit({ kind: "retract", keys: ["work#0"] });
		store.submit({ kind: "run" });
		store.advance();
		store.submit({ kind: "stop", reason: "enough" });
		store.observe(agent("task:low", "low-2", "cheap"));
		store.submit({ kind: "define", boxes: { work: null, gate: null, solo: { command: "false" } } });
		store.submit({ kind: "retract", keys: Object.keys(store.state.items).filter((key) => key !== "solo") });
		store.submit({ kind: "keep", keys: ["solo"] });
		store.submit({ kind: "run" });
		store.advance();
		return { store, log };
	}

	test("a store opened on the file holds the state the writing store had", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-log-")), "nested", "flow.jsonl");
		const { store, log } = eventful(file);
		expect([...new Set(log.map((action) => action.kind))].sort()).toEqual([
			"answered",
			"defined",
			"fired",
			"halted",
			"idled",
			"kept",
			"observed",
			"resumed",
			"retracted",
			"retried",
			"settled",
			"spawned",
			"started",
			"supplied",
		]);
		expect(readLog(file)).toEqual(log);
		expect(new Store(readLog(file), () => {}).state).toEqual(store.state);
	});

	test("a last line cut short is dropped; any other line that is not an action fails the read", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-log-"));
		const torn = path.join(dir, "torn.jsonl");
		fs.writeFileSync(torn, `${JSON.stringify({ kind: "started" })}\n{"kind":"sup`);
		expect(readLog(torn)).toEqual([{ kind: "started" }]);

		const foreign = path.join(dir, "foreign.jsonl");
		fs.writeFileSync(foreign, `${JSON.stringify({ kind: "settled", key: "a", attempt: 1 })}\n${JSON.stringify({ kind: "started" })}\n`);
		expect(() => readLog(foreign)).toThrow("line 1 is not a flow action");
	});
});

describe("what a session is told and hands back", () => {
	const store = open().store;
	store.submit({
		kind: "define",
		boxes: { work: { agent: "task:low", brief: "Do {{slice}}", in: { slice: "input.s" }, out: OUT, raises: ["question"] } },
	});
	const box = store.state.boxes.work;
	if (box?.kind !== "agent") throw new Error("work is an agent box");

	test("a continuation carries the earlier handoff and the answer, since the session itself is new", () => {
		const brief = briefOf(
			box,
			{
				key: "work",
				box: "work",
				attempt: 2,
				inputs: { slice: "a" },
				continuation: { kind: "answer", answer: "the second", previous: HANDOFF },
				earlier: { session: "S1", yielded: true },
			},
			{ board: "/notes/work.md", inherited: false },
		);
		expect(brief).toStartWith("Do a\n\n## Notes file\n`/notes/work.md`");
		expect(brief).toContain(JSON.stringify(HANDOFF, null, 1));
		expect(brief).toContain("the second");
		expect(brief).not.toContain("## Earlier work");
	});

	test("a session reopened by a check is given the earlier handoff and the check's output", () => {
		const brief = briefOf(
			box,
			{
				key: "work",
				box: "work",
				attempt: 2,
				inputs: { slice: "a" },
				continuation: { kind: "check", check: "gate", output: "expected 3, got 2", previous: HANDOFF },
				earlier: { session: "S1", yielded: true },
			},
			{ board: "/notes/work.md", inherited: false },
		);
		expect(brief).toContain("the check `gate`");
		expect(brief).toContain(JSON.stringify(HANDOFF, null, 1));
		expect(brief).toContain("expected 3, got 2");
	});

	test("the result schema requires a handoff and offers only the declared raise types", () => {
		const schema = yieldSchema(box);
		expect(schema.required).toEqual(["status", "handoff"]);
		expect(schema.properties).toMatchObject({ raise: { enum: ["question"] } });
	});

	test("yielded data outside the protocol is the runtime exception `protocol`", () => {
		expect(interpret(box, { status: "done", value: 1 })).toMatchObject({ kind: "failed", name: "protocol" });
		expect(interpret(box, { status: "raise", raise: "other", detail: "", handoff: HANDOFF })).toMatchObject({
			kind: "failed",
			name: "protocol",
		});
		expect(interpret(box, { status: "raise", raise: "question", detail: "which?", handoff: HANDOFF })).toEqual({
			kind: "raise",
			type: "question",
			detail: "which?",
			handoff: HANDOFF,
		});
		expect(interpret(box, { status: "done", value: { n: 1 }, handoff: HANDOFF })).toEqual(done({ n: 1 }));
	});
});
