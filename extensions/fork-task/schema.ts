import { z } from "@oh-my-pi/omptype/zod";
import { itemSchema } from "../_shared/fork-item.ts";

export const paramsSchema = z.object({
	context: z
		.string()
		.describe(
			"Shared context for the whole batch, with the same scoping rules as `task`: state the target, change and acceptance criteria. It reaches every child as part of its new user message, never as system text.",
		),
	tasks: z
		.array(itemSchema)
		.min(1)
		.describe(
			"One fork per item; each item stages the latest request of its own source. The order matches the `index` values in `details.progress`.",
		),
});

export const DESCRIPTION =
	"Fork a session into native task children sharing its prompt cache, agent://<id>, wait, effort, outputSchema, and schemaMode. Read `help://fork_task/limits` before using `from` or `workspace`.";
