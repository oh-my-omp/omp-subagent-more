import { describe, expect, test } from "bun:test";
import type { WorkingDirectory } from "../extensions/_shared/workspace.ts";
import { type ForkBaseline, forkDiff, unavailableTools } from "../extensions/fork-task/fork-diff.ts";
import type { Delta } from "../omomp-shared/context-delta.ts";

const HERE: WorkingDirectory = { path: "/w", repoRoot: "/w" };

const baseline: ForkBaseline = {
	cwd: HERE,
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
				cwd: HERE,
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
		const text = body(forkDiff(baseline, { cwd: HERE, tools: ["read"], contextFiles: [] }, []));
		expect(text.indexOf("`session_query`")).toBeLessThan(text.indexOf("`todo`"));
		expect(text).not.toContain("`read`");
	});

	test("names tools registered again after an earlier report", () => {
		const text = body(forkDiff(baseline, { cwd: HERE, tools: ["read", "session_query", "todo"], contextFiles: [] }, ["todo"]));
		expect(text).toContain("reported unavailable earlier");
		expect(text).toContain("`todo`");
	});

	test("reports a changed file with its current content, a missing one, and one only under the cwd", () => {
		const text = body(
			forkDiff(
				{ cwd: HERE, tools: [], contextFiles: baseline.contextFiles },
				{
					cwd: HERE,
					tools: [],
					contextFiles: [
						{ path: "/w/CLAUDE.md", content: "new rules" },
						{ path: "/w/sub/AGENTS.md", content: "Lint first." },
					],
				},
				[],
			),
		);
		expect(text).toContain("`/w/AGENTS.md`: in the parent's system prompt, but not under your working directory.");
		expect(text).toContain(
			"`/w/CLAUDE.md`: its content differs from the copy in the parent's system prompt. Its current content:\nnew rules",
		);
		expect(text).toContain(
			"`/w/sub/AGENTS.md`: under your working directory, but not in the parent's system prompt. Its content:\nLint first.",
		);
	});

	test("a file the cwd holds at another path with the same content is relocated, and a copy the prompt already carries is not added", () => {
		const text = body(
			forkDiff(
				{ cwd: HERE, tools: [], contextFiles: baseline.contextFiles },
				{
					cwd: HERE,
					tools: [],
					contextFiles: [
						{ path: "/iso/AGENTS.md", content: "Use bun." },
						{ path: "/iso/CLAUDE.md", content: "old" },
						{ path: "/home/AGENTS.md", content: "Use bun." },
					],
				},
				[],
			),
		);
		expect(text).toContain("`/w/AGENTS.md`: under your working directory as `/iso/AGENTS.md`, with the same content.");
		expect(text).toContain("`/w/CLAUDE.md`: under your working directory as `/iso/CLAUDE.md`, with the same content.");
		expect(text).not.toContain("/home/AGENTS.md");
		expect(text).not.toContain("not under your working directory");
	});

	test("an isolated child is told where the conversation ran, where it works, and how paths correspond", () => {
		const iso: WorkingDirectory = { path: "/wt/m", repoRoot: "/wt/m" };
		const text = body(forkDiff({ ...baseline, tools: [] }, { cwd: iso, tools: [], contextFiles: [] }, []));
		expect(text).toContain(
			"The conversation above ran in `/w`; your working directory is `/wt/m`. A path under `/w` in the conversation is the same relative path under `/wt/m` for you.",
		);
	});

	test("a source in a subdirectory maps paths by repository root, not by its own cwd", () => {
		const text = body(
			forkDiff(
				{ cwd: { path: "/w/pkg", repoRoot: "/w" }, tools: [], contextFiles: [] },
				{ cwd: { path: "/wt/m", repoRoot: "/wt/m" }, tools: [], contextFiles: [] },
				[],
			),
		);
		expect(text).toContain("ran in `/w/pkg`; your working directory is `/wt/m`. A path under `/w` in the conversation");
	});

	test("outside a repository only the two working directories are named", () => {
		const text = body(
			forkDiff(
				{ cwd: { path: "/a", repoRoot: undefined }, tools: [], contextFiles: [] },
				{ cwd: { path: "/b", repoRoot: undefined }, tools: [], contextFiles: [] },
				[],
			),
		);
		expect(text).toContain("The conversation above ran in `/a`; your working directory is `/b`.");
		expect(text).not.toContain("same relative path");
	});
});
