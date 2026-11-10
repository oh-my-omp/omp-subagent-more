// Drives skills/omp-subagent-more/orchestrate.js against a scripted stand-in for
// the eval prelude: agent(), wait() and output() as OMP exposes them, with
// handles whose job keeps only the first result, a published <id>.md/.json per
// run, and the superseded banner while a later run is going. Runs settle on the
// real clock in milliseconds: drive() polls OMP on real time, and the order of
// settling across items is what the barrier test observes.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// A side-effect script, as %load runs it: it defines globalThis.orchestrate and reads the prelude globals only when called.
import "../skills/omp-subagent-more/orchestrate.js";

type Value = unknown;
/** One run of a fake subagent: settles `ms` after it starts with a yield value or an error. */
type Run = { readonly ms: number; readonly value?: Value; readonly error?: string };

type Spawn = { readonly task: string; readonly options: Record<string, unknown> };

let outDir: string;
let spawns: Spawn[];
let sent: { id: string; text: string }[];
/** Scripts by the `label` prefix (item id) of the spawn: one list of runs per stage spawn, consumed in order. */
let scripts: Map<string, Run[][]>;
let expire: Set<string>;
let refuse: Set<string>;

class FakeAgent {
	static count = 0;
	readonly id: string;
	readonly handle: string;
	private runs: Run[];
	private run = 0;
	private startedAt = Date.now();
	/** The job row: the first settled run only, as OMP's handle bridge keeps it. */
	private first: { value?: Value; error?: string } | undefined;

	constructor(runs: Run[]) {
		this.id = `Agent${++FakeAgent.count}`;
		this.handle = `agent://${this.id}`;
		this.runs = runs;
	}

	private current(): Run {
		const run = this.runs[this.run];
		if (!run) throw new Error(`${this.id}: no scripted run ${this.run}`);
		return run;
	}

	private settled(): boolean {
		return Date.now() - this.startedAt >= this.current().ms;
	}

	/** Publish the current run's output once it settled, as OMP writes <id>.md and its .json sidecar. */
	async publish(): Promise<void> {
		if (!this.settled()) return;
		const run = this.current();
		if (run.error !== undefined) return;
		const md = path.join(outDir, `${this.id}.md`);
		const text = JSON.stringify(run.value);
		if ((await fs.readFile(md, "utf8").catch(() => "")) === text) return;
		await fs.writeFile(path.join(outDir, `${this.id}.json`), text);
		await fs.writeFile(md, text);
		this.first ??= { value: run.value };
	}

	async status(): Promise<string> {
		if (expire.has(this.id)) throw new Error(`unknown agent handle ${this.id}; result expired — read agent://${this.id}`);
		if (this.first) return this.first.error === undefined ? "completed" : "failed";
		if (!this.settled()) return "running";
		const run = this.current();
		this.first = run.error === undefined ? { value: run.value } : { error: run.error };
		await this.publish();
		return run.error === undefined ? "completed" : "failed";
	}

	result(): Value {
		if (!this.first) throw new Error("still running");
		if (this.first.error !== undefined) return new Error(this.first.error);
		return this.first.value;
	}

	async send(text: string): Promise<void> {
		sent.push({ id: this.id, text });
		this.run += 1;
		this.startedAt = Date.now();
	}

	async output(): Promise<{ path: string; content: string }> {
		await this.publish();
		const md = path.join(outDir, `${this.id}.md`);
		const exists = await fs.exists(md);
		if (!this.settled()) {
			return exists
				? { path: `agent://${this.id}`, content: `> \`${this.id}\` is running a newer turn. The output below is from its PREVIOUS run.` }
				: { path: `agent://${this.id}`, content: `# ${this.id} (running)\n\nNo final output yet.` };
		}
		if (this.current().error !== undefined) return { path: `agent://${this.id}`, content: `# ${this.id} (aborted)\n` };
		return { path: md, content: await fs.readFile(md, "utf8") };
	}
}

const agents = new Map<string, FakeAgent>();

beforeAll(async () => {
	outDir = await fs.mkdtemp(path.join(os.tmpdir(), "osm-orchestrate-"));
	const g = globalThis as Record<string, unknown>;
	g.agent = (task: string, options: Record<string, unknown>) => {
		spawns.push({ task, options });
		const item = String(options.label).split(".")[0] ?? "";
		if (refuse.has(item)) return Promise.reject(new Error(`unknown agent ${String(options.agent)}`));
		const runs = scripts.get(item)?.shift();
		if (!runs) throw new Error(`no script for ${item}`);
		const agent = new FakeAgent(runs);
		agents.set(agent.id, agent);
		return Promise.resolve(agent);
	};
	g.wait = async (handles: FakeAgent[], options: { raiseErrors?: boolean }) => {
		expect(options.raiseErrors).toBe(false);
		return Promise.all(handles.map(async (handle) => (await handle).result()));
	};
	g.output = async (id: string, options: { format?: string }) => {
		expect(options.format).toBe("json");
		const agent = agents.get(id);
		if (!agent) throw new Error(`Not found: ${id}`);
		return { id, ...(await agent.output()) };
	};
});

afterAll(async () => {
	await fs.rm(outDir, { recursive: true, force: true });
});

beforeEach(() => {
	spawns = [];
	sent = [];
	scripts = new Map();
	expire = new Set();
	refuse = new Set();
});

type Snapshot = {
	done: { id: string; results: { stage: number; data: Value }[] }[];
	failed: { id: string; stage: number; reason: string }[];
	needs_input: { id: string; stage: number; question: string; options?: string[] }[];
	running: { id: string; stage: number }[];
};
type Run2 = { drive(): Promise<Snapshot>; answer(id: string, text: string): Promise<unknown>; status(): Snapshot };
const orchestrate = (spec: unknown): Run2 => (globalThis as unknown as { orchestrate(spec: unknown): Run2 }).orchestrate(spec);

const N = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
const done = (data: Value, ms = 5): Run => ({ ms, value: { kind: "done", data } });
const ask = (question: string, options?: string[], ms = 5): Run => ({ ms, value: { kind: "needs_input", question, options } });
const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("orchestrate", () => {
	test("each stage is a strict two-branch yield wrapping the caller's data schema", async () => {
		scripts.set("a", [[done({ n: 1 })]]);
		const run = orchestrate({
			context: "shared",
			items: [{ id: "a", stages: [{ task: "count", data: N, agent: "task:low", isolated: true }] }],
			pollMs: 5,
		});
		await run.drive();
		const [spawn] = spawns;
		expect(spawn?.options).toMatchObject({ schemaMode: "strict", agent: "task:low", isolated: true, label: "a.1" });
		expect(spawn?.options.schema).toMatchObject({
			oneOf: [{ properties: { kind: { const: "done" }, data: N } }, { properties: { kind: { const: "needs_input" } } }],
		});
		expect(spawn?.task.startsWith("shared\n")).toBe(true);
		expect(spawn?.task).toContain("count");
		expect(spawn?.task).toContain('"needs_input"');
	});

	test("done: every item's stage data in order, nothing else", async () => {
		scripts.set("a", [[done({ n: 1 })]]);
		scripts.set("b", [[done({ n: 2 }, 20)]]);
		scripts.set("c", [[done({ n: 3 }, 10)]]);
		const run = orchestrate({ items: ["a", "b", "c"].map((id) => ({ id, stages: [{ task: id, data: N }] })), pollMs: 5 });
		const view = await run.drive();
		expect(view.done.map((row) => [row.id, row.results])).toEqual([
			["a", [{ stage: 1, data: { n: 1 } }]],
			["b", [{ stage: 1, data: { n: 2 } }]],
			["c", [{ stage: 1, data: { n: 3 } }]],
		]);
		expect(view.failed).toEqual([]);
		expect(view.needs_input).toEqual([]);
		expect(view.running).toEqual([]);
	});

	test("a new needs_input returns at once while other items keep running", async () => {
		scripts.set("slow", [[done({ n: 1 }, 400)]]);
		scripts.set("ask", [[ask("报2还是3", ["2", "3"]), done({ n: 3 })]]);
		const run = orchestrate({
			items: [
				{ id: "slow", stages: [{ task: "slow", data: N }] },
				{ id: "ask", stages: [{ task: "ask", data: N }] },
			],
			pollMs: 5,
		});
		const started = Date.now();
		const view = await run.drive();
		expect(Date.now() - started).toBeLessThan(300);
		expect(view.needs_input).toEqual([{ id: "ask", stage: 1, question: "报2还是3", options: ["2", "3"] }]);
		expect(view.running).toEqual([{ id: "slow", stage: 1 }]);
	});

	test("an answer goes to the same subagent; the next drive sees the new outcome, not the handle's first one", async () => {
		scripts.set("ask", [[ask("报2还是3", ["2", "3"]), ask("确定吗", ["是", "否"]), done({ n: 3 })]]);
		const run = orchestrate({ items: [{ id: "ask", stages: [{ task: "ask", data: N }] }], pollMs: 5 });
		expect((await run.drive()).needs_input[0]?.question).toBe("报2还是3");
		await run.answer("ask", "报3");
		const second = await run.drive();
		expect(second.needs_input).toEqual([{ id: "ask", stage: 1, question: "确定吗", options: ["是", "否"] }]);
		await run.answer("ask", "是");
		const third = await run.drive();
		expect(third.done).toEqual([{ id: "ask", results: [{ stage: 1, data: { n: 3 } }] }]);
		expect(spawns).toHaveLength(1);
		expect(sent.map((message) => message.text)).toEqual(["报3", "是"]);
		expect(new Set(sent.map((message) => message.id)).size).toBe(1);
	});

	test("answering an item that is not waiting is refused and changes nothing", async () => {
		scripts.set("a", [[done({ n: 1 })]]);
		const run = orchestrate({ items: [{ id: "a", stages: [{ task: "a", data: N }] }], pollMs: 5 });
		await run.drive();
		await expect(run.answer("a", "x")).rejects.toThrow("not waiting for an answer (it is done)");
		await expect(run.answer("nope", "x")).rejects.toThrow("no item nope");
		expect(sent).toEqual([]);
		expect(run.status().done.map((row) => row.id)).toEqual(["a"]);
	});

	test("no global barrier: an item's next stage starts when its own previous stage is done", async () => {
		scripts.set("fast", [[done({ n: 1 }, 5)], [done({ n: 2 }, 5)]]);
		scripts.set("lag", [[done({ n: 1 }, 300)], [done({ n: 2 }, 5)]]);
		const run = orchestrate({
			items: ["fast", "lag"].map((id) => ({
				id,
				stages: [
					{ task: `${id} one`, data: N },
					{ task: `${id} two`, data: N },
				],
			})),
			pollMs: 5,
		});
		const view = await run.drive();
		expect(ids(view.done)).toEqual(["fast", "lag"]);
		const order = spawns.map((spawn) => spawn.options.label);
		expect(order.indexOf("fast.2")).toBeLessThan(order.indexOf("lag.2"));
		expect(order.indexOf("fast.2")).toBeGreaterThan(-1);
		// fast.2 was spawned while lag.1 was still running: before lag.2 existed.
		expect(order).toEqual(["fast.1", "lag.1", "fast.2", "lag.2"]);
	});

	test("failures stay with their item: a failed handle, a refused spawn, an out-of-protocol yield", async () => {
		scripts.set("ok", [[done({ n: 1 })]]);
		scripts.set("bad", [[{ ms: 5, error: "schema_violation: data.n must be string" }]]);
		scripts.set("odd", [[{ ms: 5, value: { n: 1 } }]]);
		refuse.add("gone");
		const run = orchestrate({
			items: ["ok", "bad", "odd", "gone"].map((id) => ({ id, stages: [{ task: id, data: N, agent: "x" }] })),
			pollMs: 5,
		});
		const view = await run.drive();
		expect(ids(view.done)).toEqual(["ok"]);
		const reasons = Object.fromEntries(view.failed.map((row) => [row.id, row.reason]));
		expect(reasons.bad).toContain("schema_violation");
		expect(reasons.gone).toContain("unknown agent");
		expect(reasons.odd).toContain("outside the protocol");
	});

	test("a later stage that fails keeps the earlier stages' results on the item", async () => {
		scripts.set("a", [[done({ n: 1 })], [{ ms: 5, error: "cancelled" }]]);
		const run = orchestrate({
			items: [
				{
					id: "a",
					stages: [
						{ task: "one", data: N },
						{ task: "two", data: N },
					],
				},
			],
			pollMs: 5,
		});
		const view = await run.drive();
		expect(view.failed).toMatchObject([{ id: "a", stage: 2, reason: "cancelled" }]);
	});

	test("an evicted handle (result expired) is read from agent://<id>", async () => {
		scripts.set("a", [[done({ n: 7 }, 20)]]);
		expire.add(`Agent${FakeAgent.count + 1}`);
		const run = orchestrate({ items: [{ id: "a", stages: [{ task: "a", data: N }] }], pollMs: 5 });
		expect((await run.drive()).done).toEqual([{ id: "a", results: [{ stage: 1, data: { n: 7 } }] }]);
	});

	test("an answered subagent that stops without publishing a new result fails the item", async () => {
		scripts.set("a", [[ask("q?"), { ms: 30, error: "aborted" }]]);
		const run = orchestrate({ items: [{ id: "a", stages: [{ task: "a", data: N }] }], pollMs: 5 });
		await run.drive();
		await run.answer("a", "go");
		const view = await run.drive();
		expect(view.failed).toMatchObject([{ id: "a", stage: 1 }]);
		expect(view.failed[0]?.reason).toContain("aborted");
	});

	test("invalid specs are refused before anything is spawned", () => {
		expect(() => orchestrate({ items: [] })).toThrow();
		expect(() => orchestrate({ items: [{ id: "a", stages: [] }] })).toThrow("at least one stage");
		expect(() => orchestrate({ items: [{ id: "a", stages: [{ task: "x" }] }] })).toThrow("data schema");
		expect(() =>
			orchestrate({
				items: [
					{ id: "a", stages: [{ task: "x", data: N }] },
					{ id: "a", stages: [{ task: "y", data: N }] },
				],
			}),
		).toThrow("duplicate item id");
		expect(spawns).toEqual([]);
	});
});
