import type { ForkSource } from "./source.ts";
import type { ForkWorkspace } from "./workspace.ts";

function workspaceNotice(source: ForkSource, parentCwd: string, workspace: ForkWorkspace): string[] {
	const shared = workspace.kind === "shared";
	switch (source.kind) {
		case "caller":
			return [
				shared
					? "- You share the parent's working directory; files may change between your reads."
					: "- You run in an isolated copy of the workspace.",
			];
		case "agent":
		case "parked": {
			const id = `\`${source.id}\``;
			return [
				shared
					? `- You share the parent's working directory \`${parentCwd}\`; files may change between your reads.`
					: "- You run in an isolated copy of the parent's workspace.",
				workspace.kind === "inherited"
					? `- Before your first turn, the uncommitted changes ${id} made in its own isolated workspace were applied to yours: continue from them. They are handed back together with your own changes.`
					: `- Your workspace derives from the parent's checkout, not from ${id}'s: changes ${id} made in a workspace of its own are not in yours unless they reached the parent's checkout before this fork.`,
			];
		}
		default: {
			const unreachable: never = source;
			return unreachable;
		}
	}
}

export const forkNotice = (source: ForkSource, parentCwd: string, workspace: ForkWorkspace): string => {
	const origin =
		source.kind === "caller"
			? "Above: the conversation of the parent agent that spawned you, copied as background. You continue under its system prompt and tools."
			: `Above: the conversation of agent \`${source.id}\`, copied as background. You continue under its system prompt and tools, but \`${source.id}\` is not your parent: the agent that spawned you receives your result.`;
	const owner = source.kind === "caller" ? "the parent" : `\`${source.id}\``;
	const contract =
		"The parent keeps the conversation with the user. A <role> block opening the assignment defines how you work on it. Deliver your result with `yield`.";
	return [
		`<system-notice cause="fork_task">`,
		`${origin} ${contract}`,
		"- Use it only for the facts, decisions, and constraints it established.",
		`- Your job is the assignment that follows this notice, nothing else. NEVER continue, resume, or complete other work from the conversation; its todo lists and plans belong to ${owner}.`,
		"- Verification is explicitly required for this fork_task assignment: run the relevant scoped build, lint, tests, and real runtime smoke path before handoff. This overrides ordinary task's default to leave verification to the parent. Observe the changed behavior and report commands, outputs, and limitations; do not claim completion while required runtime verification is missing. Read-only roles remain read-only: report evidence from their permitted inspection instead of running execution tools.",
		source.kind === "caller"
			? "- The parent keeps working concurrently."
			: `- The parent and \`${source.id}\` may keep working concurrently.`,
		...workspaceNotice(source, parentCwd, workspace),
		"</system-notice>",
	].join("\n");
};
