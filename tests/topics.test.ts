import { afterEach, expect, test } from "bun:test";
import { DESCRIPTION, paramsSchema, resolveForkWorkspace } from "../extensions/fork-task/index.ts";
import { FORK_TASK_TOPICS, registerForkTaskTopics } from "../extensions/fork-task/topics.ts";
import { clearToolTopics, listToolTopics, resolveToolTopic } from "../omomp-shared/internal-url.ts";

afterEach(() => {
	clearToolTopics("omp-subagent-more");
});

test("fork_task registers only limits under tool://fork_task and keeps description <= 200 chars", () => {
	registerForkTaskTopics();
	expect(DESCRIPTION.length).toBeLessThanOrEqual(200);
	expect(DESCRIPTION).toContain("tool://fork_task/limits");
	expect(DESCRIPTION).not.toContain("xd://");
	expect(DESCRIPTION).not.toContain("help://");

	const listed = listToolTopics("fork_task");
	expect(listed.map((doc) => doc.topic)).toEqual(["limits"]);
	expect(FORK_TASK_TOPICS[0]?.body).not.toContain("xd://");
	expect(FORK_TASK_TOPICS[0]?.body).not.toContain("help://");
	expect(FORK_TASK_TOPICS[0]?.body).not.toContain("tool://task/");

	const resolved = resolveToolTopic("fork_task", "limits");
	expect(resolved?.content).toContain("await tool.fork_task");
	expect(resolved?.content).toContain("isolated_from_source");
});

test("fork_task paramsSchema accepts object outputSchema and 3-state workspace enum", () => {
	const parsed = paramsSchema.parse({
		context: "shared context",
		tasks: [
			{
				task: "check auth",
				workspace: "isolated_from_source",
				outputSchema: {
					type: "object",
					properties: { report: { type: "string" } },
					required: ["report"],
				},
			},
		],
	});
	expect(parsed.tasks[0]?.workspace).toBe("isolated_from_source");
	expect(parsed.tasks[0]?.outputSchema).toEqual({
		type: "object",
		properties: { report: { type: "string" } },
		required: ["report"],
	});

	expect(paramsSchema.safeParse({ context: "c", tasks: [{ task: "t", outputSchema: '{"type":"object"}' }] }).success).toBe(false);
	expect(paramsSchema.safeParse({ context: "c", tasks: [{ task: "t", workspace: "caller" }] }).success).toBe(false);
});

test("resolveForkWorkspace maps defaults and planMode consistently", () => {
	expect(resolveForkWorkspace(undefined, false, false)).toEqual({ workspace: "shared", isolated: false });
	expect(resolveForkWorkspace(undefined, true, false)).toEqual({ workspace: "isolated_from_caller", isolated: true });
	expect(resolveForkWorkspace("isolated_from_caller", false, false)).toEqual({ workspace: "isolated_from_caller", isolated: true });
	expect(resolveForkWorkspace("isolated_from_source", false, false)).toEqual({ workspace: "isolated_from_source", isolated: true });
	expect(resolveForkWorkspace("shared", true, false)).toEqual({ workspace: "shared", isolated: false });
	expect(resolveForkWorkspace("isolated_from_source", true, true)).toEqual({ workspace: "isolated_from_source", isolated: false });
});
