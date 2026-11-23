import { describe, expect, test } from "bun:test";
import type { Json } from "../extensions/flow/defs.ts";
import type { Firing } from "../extensions/flow/plan.ts";
import { definitionKey, modelKey, type Outcome } from "../extensions/flow/state.ts";
import { Store } from "../extensions/flow/store.ts";

type Spec = { boxes: Record<string, Record<string, Json>>; inputs?: Record<string, Json>; noEscape?: boolean };
type Preset = (options: Record<string, Json>, ...specs: Record<string, Json>[]) => Spec;
const presetsUrl = new URL("../skills/omp-subagent-ng/presets.js", import.meta.url).href;
const { swarm, loop }: { swarm: Preset; loop: Preset } = await import(presetsUrl);

const HANDOFF: Json = { did: "work", decided: [], unverified: [] };
const done = (value: Json): Outcome => ({ kind: "done", value, handoff: HANDOFF });

type Flow = { readonly store: Store; readonly fire: () => string[] };

function open(): Flow {
	const store = new Store([], () => {});
	store.observe({
		[definitionKey("flow:worker")]: "worker-1",
		[definitionKey("flow:adjudicator")]: "adjudicator-1",
		[definitionKey("flow:guardian")]: "guardian-1",
		[definitionKey("task:low")]: "low-1",
		[modelKey("task:low")]: "cheap",
	});
	const keys = (firings: readonly Firing[]): string[] => firings.map((firing) => `${firing.key}@${firing.attempt}`);
	return { store, fire: () => keys(store.advance()) };
}

function use(flow: Flow, spec: Spec) {
	const defined = flow.store.submit({ kind: "define", boxes: spec.boxes, noEscape: spec.noEscape });
	for (const [name, value] of Object.entries(spec.inputs ?? {})) flow.store.submit({ kind: "supply", name, value });
	return defined;
}

const SWARM = () =>
	swarm(
		{ model: "task:low", request: "input.issue", inputs: { issue: "#7", slices: ["a", "b"] }, noEscape: true },
		{ name: "api", brief: "Build {{slice}} for {{issue}}", in: { slice: "input.slices[]", issue: "input.issue" } },
		{ name: "docs", brief: "Document {{issue}}", in: { issue: "input.issue" } },
	);

describe("swarm", () => {
	test("its spec is plain JSON that the engine accepts as given, inputs and noEscape included", () => {
		const spec = SWARM();
		expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
		const flow = open();
		expect(use(flow, spec).refusals).toEqual([]);
		expect(flow.store.state.noEscape).toBe(true);
		expect(flow.store.submit({ kind: "run" }).accepted).toBe(true);
		expect(flow.fire().sort()).toEqual(["api#0@1", "api#1@1", "docs@1"]);
	});

	test("each worker's question goes to its own ruling box, whose own raise reaches outside the flow", () => {
		const flow = open();
		use(flow, SWARM());
		flow.store.submit({ kind: "run" });
		flow.fire();
		flow.store.settle("api#1", 1, { kind: "raise", type: "question", detail: "which endpoint?", handoff: HANDOFF });
		expect(flow.fire()).toEqual(["api_ruling<api#1@1>@1"]);
		flow.store.settle("api_ruling<api#1@1>", 1, { kind: "raise", type: "ask_user", detail: "product call", handoff: HANDOFF });
		expect(flow.store.state.items["api_ruling<api#1@1>"]?.phase.kind).toBe("raised");
		flow.store.submit({ kind: "answer", key: "api_ruling<api#1@1>", value: "use /v2" });
		expect(flow.fire()).toEqual(["api_ruling<api#1@1>@2"]);
		flow.store.settle("api_ruling<api#1@1>", 2, done({ ruling: "use /v2" }));
		expect(flow.fire()).toEqual(["api#1@2"]);
	});

	test("its gate checks every worker at once, by path for a fanned worker, and its reduce takes every worker whole", () => {
		const spec = swarm(
			{
				model: "task:low",
				gate: { command: "check {{api}} {{web}}" },
				reduce: { agent: "flow:guardian", model: "task:low", brief: "{{api}} {{web}}" },
			},
			{ name: "api", brief: "{{slice}}", in: { slice: "input.slices[]" } },
			{ name: "web", brief: "{{slice}}", in: { slice: "input.slices[]" } },
		);
		expect(spec.boxes.gate).toEqual({ command: "check {{api}} {{web}}", in: { api: "api[]", web: "web[]" }, checks: ["api", "web"] });
		expect(spec.boxes.reduce?.in).toEqual({ api: "api", web: "web" });
		const flow = open();
		expect(use(flow, spec).refusals).toEqual([]);
		expect(flow.store.survey().problems).toEqual([]);
	});
});

const LOOP = () =>
	loop(
		{
			over: "input.items[]",
			model: "task:low",
			rounds: 2,
			check: { agent: "flow:guardian", model: "task:low", brief: "Judge {{red}} against {{blue}}", out: { type: "object" } },
			inputs: { items: ["x", "y"] },
		},
		{ name: "red", brief: "Attack {{item}}" },
		{ name: "blue", brief: "Defend {{item}}" },
	);

describe("loop", () => {
	test("its parallel agents fan out over one input, and the check zips them by path and checks them all", () => {
		const spec = LOOP();
		expect(spec.boxes.check).toMatchObject({ in: { red: "red[]", blue: "blue[]" }, checks: ["red", "blue"] });
		const flow = open();
		expect(use(flow, spec).refusals).toEqual([]);
		flow.store.submit({ kind: "run" });
		expect(flow.fire().sort()).toEqual(["blue#0@1", "blue#1@1", "red#0@1", "red#1@1"]);
		for (const key of ["red#0", "blue#0", "red#1"]) flow.store.settle(key, 1, done({ by: key }));
		expect(flow.fire()).toEqual([]);
		flow.store.settle("blue#1", 1, done({ by: "blue#1" }));
		expect(flow.store.advance().map((firing) => [firing.key, firing.inputs])).toEqual([
			["check#0", { red: { by: "red#0" }, blue: { by: "blue#0" } }],
			["check#1", { red: { by: "red#1" }, blue: { by: "blue#1" } }],
		]);
	});

	test("a rejection reopens every agent at that path with what the check was given, until `rounds` is spent", () => {
		const flow = open();
		use(flow, LOOP());
		flow.store.submit({ kind: "run" });
		flow.fire();
		for (const key of ["red#0", "blue#0", "red#1", "blue#1"]) flow.store.settle(key, 1, done({ by: key }));
		flow.fire();
		flow.store.settle("check#1", 1, done({ ok: true }));
		flow.store.settle("check#0", 1, { kind: "rejected", output: "blue missed the attack" });
		const reopened = flow.store.advance();
		expect(reopened.map((firing) => [firing.key, firing.attempt, firing.continuation?.kind])).toEqual([
			["blue#0", 2, "check"],
			["red#0", 2, "check"],
		]);
		expect(reopened[0]?.continuation).toMatchObject({ snapshot: { red: { by: "red#0" }, blue: { by: "blue#0" } } });
		for (const key of ["red#0", "blue#0"]) flow.store.settle(key, 2, done({ by: key, round: 2 }));
		flow.fire();
		flow.store.settle("check#0", 1, { kind: "rejected", output: "still missed" });
		expect(flow.store.state.mode).toMatchObject({ kind: "stopped", cause: { key: "check#0", name: "bound_exceeded" } });
	});

	test("`over` must be a `[]` reference and `check` is required", () => {
		expect(() => loop({ over: "input.items", check: { command: "true" } }, { name: "a", brief: "x" })).toThrow("`over`");
		expect(() => loop({ over: "input.items[]" }, { name: "a", brief: "x" })).toThrow("`check`");
	});
});

describe("composing specs", () => {
	test("the boxes of a preset and of any other template merge by spreading and run as one flow", () => {
		const external = { boxes: { summary: { command: "printf %s {{red}}", in: { red: "red" } } } };
		const loopSpec = LOOP();
		const flow = open();
		expect(use(flow, { boxes: { ...loopSpec.boxes, ...external.boxes }, inputs: loopSpec.inputs }).refusals).toEqual([]);
		expect(flow.store.survey().problems).toEqual([]);
		expect(flow.store.submit({ kind: "run" }).accepted).toBe(true);
	});
});
