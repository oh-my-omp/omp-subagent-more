import { z } from "@oh-my-pi/omptype/zod";

const itemSchema = z.object({
	from: z
		.string()
		.optional()
		.describe(
			"Id of another registered agent to fork instead of your conversation, as in `agent://<id>`; any thread of this process works, live, idle or parked. Matched exactly, then case-insensitively; advisors cannot be sources, and an empty value or your own id selects your conversation. A parked source is forked from the request it kept at park without waking it. Omit to fork your own conversation.",
		),
	name: z
		.string()
		.optional()
		.describe(
			"Requested child name, unique within the call: kept characters `[A-Za-z0-9_-]`, truncated to 48. The child's id is allocated from it as for `task`, with `-2`, `-3`, … appended when an earlier agent of this session holds it. Omit for a generated name; use the returned id for follow-ups.",
		),
	agent: z
		.string()
		.optional()
		.describe(
			"Agent whose model binding and role prompt the child takes: its `task.agentModelOverrides` binding, else its definition's `model`, and its definition prompt as a `<role>` block in the assignment. The child keeps the source's tools, so the definition's tool restrictions do not apply; a different model reuses no cache. Omit to run the source's model, thinking level and request controls.",
		),
	task: z
		.string()
		.describe(
			"This item's assignment: what to do, with its own target, change and acceptance criteria. Joined after the shared `context` (and any role block) as the child's new user message.",
		),
	workspace: z
		.enum(["shared", "isolated_from_caller", "isolated_from_source"])
		.optional()
		.describe(
			"Where the child runs: `shared` shares your checkout, `isolated_from_caller` creates a new worktree from your checkout, and `isolated_from_source` creates an isolated worktree seeded with `from`'s uncommitted isolated changes (needs a stopped `from` agent; fails before dispatch if ineligible — see `help://fork_task/limits`). Defaults to `shared` without `agent` and `isolated_from_caller` with `agent`; plan mode forces `shared`. Isolated children merge changes back on completion and cannot be resumed.",
		),
	shake: z
		.boolean()
		.optional()
		.describe(
			'Elide the inherited transcript before the child starts, by running the same `session.shake("elide")` as `/shake`: keeps the newest tokens and `skill://`/`local://PLAN.md` reads, and replaces older text with recovery references in the shared artifact store. Gives up exact inherited-prefix cache reuse. Defaults to false.',
		),
	effort: z
		.enum(["lo", "med", "hi"])
		.optional()
		.describe(
			"Thinking effort for the child, mapped onto the target model's own thinking range: `lo` is its lowest supported level, `med` the middle one (the lower of the two middles when the range has an even count), `hi` its highest (high, xhigh or max). Omit to keep the source's level; a changed effort keeps the replicated prefix. Has no effect while `task.enableEffort` is false.",
		),
	outputSchema: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'JSON Schema object for the child\'s `yield` payload: e.g. {"type":"object","properties":{"report":{"type":"string"}},"required":["report"]}. Every child delivers through `yield`; its schema is this one, else the `output` of the role named in `agent`, else `{report: string}`. While `task.structured` is off the host ignores this field and the role\'s `output`, so the child takes `{report: string}`.',
		),
	schemaMode: z
		.enum(["permissive", "strict"])
		.optional()
		.describe(
			"How the child's `yield` payload is enforced against the output schema. `permissive` keeps legacy retry-budget behavior; `strict` turns every invalid final payload into a failed `schema_violation`. Defaults to `permissive`, or the session's `outputSchemaMode`.",
		),
});

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

export type ForkItem = z.infer<typeof itemSchema>;

export const DESCRIPTION =
	"Fork a session into native task children sharing its prompt cache, agent://<id>, wait, effort, outputSchema, and schemaMode. Read `help://fork_task/limits` before using `from` or `workspace`.";
