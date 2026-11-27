import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerForkTask } from "../extensions/fork-task/index.ts";
import { type Answer, type Ask, createReportLimit, parseAnswer, VERDICTS_LOG } from "../extensions/fork-task/report-limit.ts";

type Logged = { readonly level: "info" | "warn"; readonly message: string; readonly data: Record<string, unknown> };

function harness(answers: ReadonlyArray<readonly [string, Answer]>) {
	const logs: Logged[] = [];
	const prompts: string[] = [];
	const check = createReportLimit({
		info: (message, data) => logs.push({ level: "info", message, data }),
		warn: (message, data) => logs.push({ level: "warn", message, data }),
	});
	const ask: Ask = async (_system, prompt) => {
		prompts.push(prompt);
		const hit = answers.find(([key]) => prompt.includes(key));
		return hit?.[1] ?? { kind: "text", text: "report-limit: false" };
	};
	return { logs, prompts, inspect: (input: unknown, tool = "fork_task") => check.inspect(tool, input, ask) };
}

const CAPPED: readonly [string, Answer] = ["不超过 50 字", { kind: "text", text: "report-limit: true" }];

describe("report-limit on fork_task", () => {
	test("a capped item blocks the whole call and names only the flagged item", async () => {
		const h = harness([CAPPED]);
		const reason = await h.inspect({
			context: "repo /work",
			tasks: [
				{ name: "count", agent: "task:low", task: "统计文件数，汇报不超过 50 字" },
				{ name: "list", agent: "task:low", task: "列出文件" },
			],
		});
		expect(reason).toContain("`count`");
		expect(reason).not.toContain("`list`");
		expect(reason).toContain("local://<name>.md");
	});

	test("a flagged prompt is not remembered: the unchanged resend is judged and blocked again", async () => {
		const h = harness([CAPPED]);
		const input = { context: "", tasks: [{ agent: "task:low", task: "汇报不超过 50 字" }] };
		expect(await h.inspect(input)).not.toBeNull();
		expect(await h.inspect(input)).not.toBeNull();
		expect(h.prompts).toHaveLength(2);
	});

	test("a clear prompt is remembered: the same trimmed context and task skip the model", async () => {
		const h = harness([]);
		expect(await h.inspect({ context: "ctx", tasks: [{ task: "do it" }] })).toBeNull();
		expect(await h.inspect({ context: "  ctx ", tasks: [{ task: "do it\n" }] })).toBeNull();
		expect(h.prompts).toHaveLength(1);
		expect(await h.inspect({ context: "ctx", tasks: [{ task: "do it twice" }] })).toBeNull();
		expect(h.prompts).toHaveLength(2);
	});

	test("the shared context alone can carry the cap", async () => {
		const h = harness([CAPPED]);
		expect(await h.inspect({ context: "每项汇报不超过 50 字", tasks: [{ task: "count files" }] })).not.toBeNull();
		expect(h.prompts[0]).toContain("<shared-context>\n每项汇报不超过 50 字\n</shared-context>");
	});

	test("only task:* items and items without agent are judged", async () => {
		const h = harness([CAPPED]);
		const reason = await h.inspect({
			context: "",
			tasks: [
				{ name: "named", agent: "reviewer", task: "汇报不超过 50 字" },
				{ name: "own", task: "ok" },
			],
		});
		expect(reason).toBeNull();
		expect(h.prompts).toHaveLength(1);
		expect(h.prompts[0]).toContain("<assignment>\nok\n</assignment>");
	});

	test("no model, a failed request or an unparseable answer lets the call run and warns", async () => {
		for (const answer of [
			{ kind: "failed", why: "no model" },
			{ kind: "text", text: "I think so" },
		] satisfies Answer[]) {
			const h = harness([["x", answer]]);
			expect(await h.inspect({ context: "", tasks: [{ task: "x" }] })).toBeNull();
			expect(h.logs.some((log) => log.level === "warn")).toBe(true);
			const verdicts = h.logs.find((log) => log.message === VERDICTS_LOG);
			expect(JSON.stringify(verdicts?.data)).toContain('"unknown"');
		}
	});

	test("an unknown verdict is not remembered", async () => {
		const h = harness([["x", { kind: "failed", why: "deadline" }]]);
		await h.inspect({ context: "", tasks: [{ task: "x" }] });
		await h.inspect({ context: "", tasks: [{ task: "x" }] });
		expect(h.prompts).toHaveLength(2);
	});

	test("one verdict log line per judged call, none for calls with nothing to judge or other tools", async () => {
		const h = harness([]);
		await h.inspect({ context: "", tasks: [{ task: "a" }, { task: "b" }] });
		await h.inspect({ context: "", tasks: [{ agent: "reviewer", task: "c" }] });
		await h.inspect({ context: "", tasks: [{ task: "d" }] }, "task");
		await h.inspect({ nonsense: true });
		expect(h.logs.filter((log) => log.message === VERDICTS_LOG)).toHaveLength(1);
	});
});

describe("parseAnswer", () => {
	test.each([
		["report-limit: true", "flagged"],
		["**report-limit**: `false`", "clear"],
		["- report-limit : TRUE", "flagged"],
		["Report-Limit: false\nreason", "clear"],
		["yes", "unknown"],
		["report-limit: maybe", "unknown"],
	])("%p → %s", (text, kind) => {
		expect(parseAnswer(text).kind as string).toBe(kind);
	});
});

describe("fork_task report-limit after omompTool normalization", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function setupForkTask(answers: ReadonlyArray<readonly [string, Answer]>) {
		const events: string[] = [];
		const prompts: string[] = [];
		let registered: ToolDefinition | undefined;
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
			registerTool: (tool: ToolDefinition) => {
				registered = tool;
			},
			events: {},
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
		} as unknown as ExtensionAPI;

		const ask: Ask = async (_system, prompt) => {
			prompts.push(prompt);
			const hit = answers.find(([key]) => prompt.includes(key));
			return hit?.[1] ?? { kind: "text", text: "report-limit: false" };
		};
		registerForkTask(pi, ask);
		if (!registered) throw new Error("fork_task was not registered");

		const session = {
			settings: Settings.isolated({ "async.enabled": true, "task.maxRecursionDepth": 2 }),
			asyncJobManager: {},
			getToolByName: (name: string) => (name === "task" ? {} : undefined),
			sessionManager: {
				ensureOnDisk: async () => {},
				flush: async () => {},
				getSessionFile: () => "/tmp/caller-session.jsonl",
			},
		} as unknown as AgentSession;

		AgentRegistry.global().register({
			id: "caller",
			displayName: "caller",
			kind: "main",
			status: "running",
			session,
			sessionFile: "/tmp/caller-session.jsonl",
		});

		const ctx = { agent: { id: "caller", depth: 0 } } as unknown as ExtensionContext;
		const call = (input: unknown) => (registered as ToolDefinition).execute("call-1", input as never, undefined, undefined, ctx);

		return { events, prompts, registered, call };
	}

	test("does not inspect on tool_call; runs inside omompTool-wrapped execute", () => {
		const { events, registered } = setupForkTask([]);
		expect(events).not.toContain("tool_call");
		expect(Reflect.get(registered, "lenientArgValidation")).toBe(true);
	});

	test.each([
		{ label: "empty string", agent: "", name: "" },
		{ label: "whitespace", agent: "  ", name: "  " },
		{ label: "null", agent: null, name: null },
	])("treats $label agent and name identically to omitting them", async ({ agent, name }) => {
		const { prompts, call } = setupForkTask([CAPPED]);
		const result = await call({
			context: "汇报不超过 50 字",
			tasks: [{ agent, name, task: "count files" }],
		});
		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("`item 1`");
		expect(prompts).toHaveLength(1);
	});

	test("trims whitespace around task:* agent names before matching", async () => {
		const { prompts, call } = setupForkTask([CAPPED]);
		const result = await call({
			context: "repo",
			tasks: [{ agent: "  task:low  ", name: "worker", task: "汇报不超过 50 字" }],
		});
		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("`worker`");
		expect(prompts).toHaveLength(1);
	});

	test("strips null/empty optional and undeclared fields without skipping batch judgment", async () => {
		const { prompts, call } = setupForkTask([CAPPED]);
		const result = await call({
			context: "repo",
			role: null,
			tasks: [
				{ agent: null, name: null, outputSchema: null, task: "ok" },
				{ agent: "task:low", name: "flagged", outputSchema: {}, task: "汇报不超过 50 字" },
			],
		});
		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("`flagged`");
		expect(text).not.toContain("`item 1`");
		expect(prompts).toHaveLength(2);
	});

	test.each([
		{ context: null, tasks: [{ task: "汇报不超过 50 字" }] },
		{ context: "  ", tasks: [{ task: "汇报不超过 50 字" }] },
		{ context: "ok", tasks: [] },
		{ context: "ok", tasks: null },
		{ context: "ok", tasks: [{}] },
		{ context: "ok", tasks: [{ name: "" }] },
		{ context: "ok", tasks: [null] },
		{ context: "ok", tasks: [{ task: "  " }] },
		{ context: "ok", tasks: [{ task: "ok" }, {}] },
	])("refuses empty required fields and empty array elements at omompTool before report-limit runs: %j", (input) => {
		const { prompts, call } = setupForkTask([CAPPED]);
		expect(() => call(input)).toThrow('Validation failed for tool "fork_task"');
		expect(prompts).toHaveLength(0);
	});
});
