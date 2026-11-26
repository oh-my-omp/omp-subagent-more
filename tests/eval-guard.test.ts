import { describe, expect, test } from "bun:test";
import { inspectEval, type Load, type LoadTarget } from "../extensions/flow/eval-guard.ts";

const DISPATCH_PY = 'for key in keys:\n    handles[key] = agent(brief, agent="task:free1", label=key)';

function files(entries: Record<string, string>): { load: Load; asked: LoadTarget[] } {
	const asked: LoadTarget[] = [];
	const load: Load = async (target) => {
		asked.push(target);
		const code = entries[target.file];
		return code === undefined ? null : { path: `/abs/${target.file}`, code };
	};
	return { load, asked };
}

const none = files({}).load;
const py = (code: string, load: Load = none) => inspectEval("eval", { language: "py", code }, load);
const js = (code: string, load: Load = none) => inspectEval("eval", { language: "js", code }, load);

describe("eval guard: calls in the cell", () => {
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

	test("Python calls in f-string expressions, after magic lines and inside %%capture bodies are refused", async () => {
		expect(await py("x = f\"{agent('a')}\"")).toContain("`agent()`");
		expect(await py('!ls\nfiles = !ls\nout = %pwd\nagent("hi")')).toContain("`agent()`");
		expect(await py('!echo "unclosed (paren\nagent("p")')).toContain("`agent()`");
		expect(await py('%%capture out\nworkpool("task:low")')).toContain("`workpool()`");
	});

	test("names in strings, comments, members, keyword arguments and cell-magic payloads do not refuse the cell", async () => {
		expect(await py('# agent(x)\ns = "workpool(1)"\nobj.agent(1)\nr = await tool.task({"tasks": [{"agent": "task:low"}]})')).toBeNull();
		expect(await py('s = """\n%load evil.py\nagent(1)\n"""')).toBeNull();
		expect(await py('%%writefile dispatch.py\nagent("x")')).toBeNull();
		expect(
			await js(
				'// agent(1)\nconst s = "workpool(2)";\nobj.agent(3);\nawait tool.fork_task({ tasks: [{ agent: "task:low", task: "t" }] });',
			),
		).toBeNull();
	});

	test("flow, task, fork_task, wait, judge, judgeBatch and completion cells run", async () => {
		expect(await js('const r = await tool.flow({ op: "status" });')).toBeNull();
		expect(await js("await flow.run();\nconst v = await flow.value('scout');")).toBeNull();
		expect(
			await js("await judge(s, q);\nconst b = await judgeBatch(a, q);\nconst h = await completion('x');\nawait wait([h]);"),
		).toBeNull();
		expect(await py("print(judge_batch(states, q))\nh = completion('x')\nwait([h])")).toBeNull();
	});

	test("other tools and malformed eval input are not inspected", async () => {
		expect(await inspectEval("bash", { language: "py", code: "agent('x')" }, none)).toBeNull();
		expect(await inspectEval("eval", { code: "agent('x')" }, none)).toBeNull();
	});
});

describe("eval guard: scripts included with %load", () => {
	test("a standalone %load cell is judged by the script it runs, in either language", async () => {
		const f = files({
			"dispatch.py": DISPATCH_PY,
			"pool.js": 'await workpool("task:low");',
			"flow.js": "await tool.flow({ op: 'status' });",
		});
		expect(await py('%load "dispatch.py"', f.load)).toContain("`agent()`");
		expect(await js("%load pool.js", f.load)).toContain("`workpool()`");
		expect(await js("%load flow.js", f.load)).toBeNull();
		expect(f.asked).toEqual([
			{ kind: "cell", file: "dispatch.py" },
			{ kind: "cell", file: "pool.js" },
			{ kind: "cell", file: "flow.js" },
		]);
	});

	test("an inline Python %load line is followed, also through nested scripts", async () => {
		const f = files({ "outer.py": "import os\n%load inner.py", "inner.py": DISPATCH_PY });
		expect(await py('x = 1\n%load "outer.py"\nprint(x)', f.load)).toContain("`agent()`");
		expect(f.asked).toEqual([
			{ kind: "line", file: "outer.py" },
			{ kind: "line", file: "inner.py" },
		]);
	});

	test("a %load cycle ends and an unreadable script lets the cell run", async () => {
		const f = files({ "a.py": "%load b.py", "b.py": "%load a.py" });
		expect(await py("%load a.py", f.load)).toBeNull();
		expect(await py("%load missing.py\nprint(1)", f.load)).toBeNull();
	});
});
