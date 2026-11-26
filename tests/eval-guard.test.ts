import { describe, expect, test } from "bun:test";
import { inspectEval } from "../extensions/flow/eval-guard.ts";

const py = (code: string) => inspectEval("eval", { language: "py", code });
const js = (code: string) => inspectEval("eval", { language: "js", code });

describe("eval guard", () => {
	test("the reported Python dispatch cell is refused, naming agent() and help://flow/eval", async () => {
		const reason = await py(
			'handles = {}\nfor key in packets:\n    handles[key] = agent(brief.format(path=f"local://compact-eval/{key}.md", key=key), agent="task:free1", label=f"Judge-{key}", schema=schema)',
		);
		expect(reason).toContain("`agent()`");
		expect(reason).not.toContain("`workpool()`");
		expect(reason?.split("\n").at(-1)).toBe("help://flow/eval");
	});

	test("a cell calling both names both, in either language", async () => {
		expect(await py('h = agent("x")\np = workpool("task:low")')).toContain("`agent()` and `workpool()`");
		expect(await js('const h = await agent("x");\nconst p = await workpool("task:low", { name: "p" });')).toContain(
			"`agent()` and `workpool()`",
		);
	});

	test("JS calls through globalThis and inside template interpolations are refused", async () => {
		expect(await js('await globalThis.workpool("task:low");')).toContain("`workpool()`");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the cell source holds a JS template literal
		expect(await js("const t = `${await agent('q')}`;")).toContain("`agent()`");
	});

	test("Python calls inside f-string expressions and cells with magics are refused", async () => {
		expect(await py("x = f\"{agent('a')}\"")).toContain("`agent()`");
		expect(await py('%load skill://x\n!ls\nagent("hi")')).toContain("`agent()`");
	});

	test("names in strings, comments, members and keyword arguments do not refuse the cell", async () => {
		expect(await py('# agent(x)\ns = "workpool(1)"\nobj.agent(1)\nr = await tool.task({"tasks": [{"agent": "task:low"}]})')).toBeNull();
		expect(
			await js(
				'// agent(1)\nconst s = "workpool(2)";\nobj.agent(3);\nawait tool.fork_task({ tasks: [{ agent: "task:low", task: "t" }] });',
			),
		).toBeNull();
	});

	test("flow, task, fork_task, wait, judge, judgeBatch and completion cells run", async () => {
		expect(await js('const r = await tool.flow({ op: "status" });\n%load skill://omp-subagent-ng/flow.js')).toBeNull();
		expect(await js("await flow.run();\nconst v = await flow.value('scout');")).toBeNull();
		expect(
			await js("await judge(s, q);\nconst b = await judgeBatch(a, q);\nconst h = await completion('x');\nawait wait([h]);"),
		).toBeNull();
		expect(await py("print(judge_batch(states, q))\nh = completion('x')\nwait([h])")).toBeNull();
	});

	test("other tools and malformed eval input are not inspected", async () => {
		expect(await inspectEval("bash", { language: "py", code: "agent('x')" })).toBeNull();
		expect(await inspectEval("eval", { code: "agent('x')" })).toBeNull();
	});
});
