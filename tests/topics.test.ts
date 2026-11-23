import { expect, test } from "bun:test";
import { paramsSchema } from "../extensions/fork-task/schema.ts";
import { resolveForkWorkspace } from "../extensions/fork-task/workspace.ts";

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

test("resolveForkWorkspace defaults by role and lets plan mode force a shared child", () => {
	expect(resolveForkWorkspace(undefined, false, false)).toEqual({ kind: "shared" });
	expect(resolveForkWorkspace(undefined, true, false)).toEqual({ kind: "isolated" });
	expect(resolveForkWorkspace("isolated_from_caller", false, false)).toEqual({ kind: "isolated" });
	expect(resolveForkWorkspace("isolated_from_source", false, false)).toEqual({ kind: "inherit" });
	expect(resolveForkWorkspace("shared", true, false)).toEqual({ kind: "shared" });
	expect(resolveForkWorkspace(undefined, true, true)).toEqual({ kind: "shared" });
	expect(resolveForkWorkspace("isolated_from_source", true, true)).toMatchObject({ kind: "rejected", code: "child-not-isolated" });
});
