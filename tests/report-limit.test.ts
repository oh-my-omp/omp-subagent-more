import { describe, expect, test } from "bun:test";
import { type Answer, type Ask, createReportLimit, parseAnswer, VERDICTS_LOG } from "../extensions/fork-task/report-limit.ts";

type Logged = { readonly level: "info" | "warn"; readonly message: string; readonly data: Record<string, unknown> };

/** A check with captured logs, and a scripted model: each prompt containing a key answers with its text. */
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
		// A changed task is a new prompt.
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
