import { registerToolTopics, type ToolTopicDoc, toDocTopics } from "../../omomp-shared/internal-url.ts";

export const LIMITS_TOPIC_BODY = `# Prerequisites, unsupported fields, source errors and workspace inheritance

- Companion to native \`task\`: children keep \`task\` result delivery (\`agent://<id>\`), \`wait\`, \`effort\`, \`outputSchema\`, and \`schemaMode\`, while replicating the source's exact system prompt, tools, and cached prefix.
- Requires background jobs (\`async.enabled\`), the native \`task\` tool, batch mode and a persisted session; a missing prerequisite is named in the error.
- At \`task.maxRecursionDepth\`: when the caller's \`taskDepth\` + 1 reaches the cap, \`fork_task\` returns a tool error before staging anything; the child would have no \`task\` tool to replicate.
- No inherited-size or cost limit exists: no item checks the inherited token count or the source's cost.
- Not fork fields: \`steps\`, \`solutionSpace\`, \`model\`, \`tools\`. \`steps\` is the host \`task\` item's alternative to \`task\` (a host item takes one of the two, never both); a fork item takes one \`task\`, so put every step's instructions into that \`task\`, in order.
- Source errors before dispatch name an unregistered source, a parked source OMP kept no request for (wake it with \`write agent://<id>\`, then fork) or whose transcript moved past that request, a source in another thread that did not answer (retry), a source that has sent no request in this process, an unknown, disabled or internal \`agent\`, or a source with no persisted transcript.
- \`workspace: "isolated_from_source"\` applies the \`from\` agent's uncommitted isolated changes before the child's first turn and hands them back together with the child's changes; the source keeps its workspace. Ineligible calls fail before dispatch with a coded \`workspace "isolated_from_source" rejected (<code>)\` error.
- In isolated children, absolute paths from the copied conversation point to another checkout: use the same repository-relative paths in the child's own checkout.
- Children replay an in-process request snapshot; same-process idle/park follow-ups are supported, while cold revival after restart fails before provider dispatch (create a fresh fork instead).
- From an eval cell, \`await tool.fork_task(...)\` dispatches the same forks and returns once spawned; results arrive in the conversation, not in the cell.
`;

export const FORK_TASK_TOPICS: readonly ToolTopicDoc[] = [
	{
		tool: "fork_task",
		topic: "limits",
		title: "Prerequisites, unsupported fields, and workspace inheritance",
		when: "before using `from` or `workspace`, or when `fork_task` refuses to start",
		body: LIMITS_TOPIC_BODY,
	},
];

export const docTopics: () => Readonly<Record<string, string>> = toDocTopics(FORK_TASK_TOPICS);

export function registerForkTaskTopics(): void {
	registerToolTopics("omp-subagent-ng", FORK_TASK_TOPICS);
}
