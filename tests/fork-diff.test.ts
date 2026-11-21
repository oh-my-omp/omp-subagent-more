import { describe, expect, test } from "bun:test";
import type { Delta } from "../omomp-shared/context-delta.ts";
import { type ForkBaseline, forkDiff, unavailableTools } from "../extensions/fork-task/fork-diff.ts";

const baseline: ForkBaseline = {
	tools: ["read", "session_query", "todo"],
	contextFiles: [
		{ path: "/w/AGENTS.md", text: "<file path=/w/AGENTS.md>\nUse bun.\n</file>" },
		{ path: "/w/CLAUDE.md", text: "<file>old</file>" },
	],
};

const body = (delta: Delta): string => (delta.kind === "text" ? delta.body : "");

describe("forkDiff", () => {
	test("nothing differs when every declared tool is registered and each file's content is inside its prompt fragment", () => {
		const delta = forkDiff(
			baseline,
			{
				tools: ["read", "session_query", "todo", "yield"],
				contextFiles: [
					{ path: "/w/AGENTS.md", content: "Use bun.\n" },
					{ path: "/w/CLAUDE.md", content: "old" },
				],
			},
			[],
		);
		expect(delta).toEqual({ kind: "none" });
	});

	test("lists declared tools the child has no registration for, in declaration order", () => {
		expect(unavailableTools(baseline, ["read"])).toEqual(["session_query", "todo"]);
		const text = body(forkDiff(baseline, { tools: ["read"], contextFiles: [] }, []));
		expect(text.indexOf("`session_query`")).toBeLessThan(text.indexOf("`todo`"));
		expect(text).not.toContain("`read`");
	});

	test("names tools registered again after an earlier report", () => {
		const text = body(forkDiff(baseline, { tools: ["read", "session_query", "todo"], contextFiles: [] }, ["todo"]));
		expect(text).toContain("reported unavailable earlier");
		expect(text).toContain("`todo`");
	});

	test("reports a file missing from the cwd, one only under the cwd, and one whose content changed, with the current content", () => {
		const text = body(
			forkDiff(
				{ tools: [], contextFiles: baseline.contextFiles },
				{
					tools: [],
					contextFiles: [
						{ path: "/w/CLAUDE.md", content: "new rules" },
						{ path: "/iso/AGENTS.md", content: "Use bun." },
					],
				},
				[],
			),
		);
		expect(text).toContain("`/w/AGENTS.md`: in the parent's system prompt, but not under your working directory.");
		expect(text).toContain("`/w/CLAUDE.md`: its content differs");
		expect(text).toContain("new rules");
		expect(text).toContain("`/iso/AGENTS.md`: under your working directory, but not in the parent's system prompt. Its content:\nUse bun.");
	});
});
