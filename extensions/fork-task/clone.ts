import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { contextFileCapability, type ContextFile as HostContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { expandAtImports } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";
import type { Delta } from "../../omomp-shared/context-delta.ts";
import { type ContextFile, type ForkBaseline, type ForkCurrent, forkDiff, unavailableTools, type WorkingDirectory } from "./fork-diff.ts";
import type { OwnYield } from "./replica.ts";
import { readOptional } from "./replica-file.ts";

export type Clone = {
	readonly ownYield: OwnYield | undefined;
	readonly baseline: ForkBaseline;
	readonly cwd: WorkingDirectory;
	readonly reported: Set<string>;
};

const YIELD_UNDECLARED =
	"You deliver your result with the `yield` tool. It is not among the tools declared to you, because the declaration stays identical to the parent's request to keep its prompt cache; it is registered in this session all the same.";

const YIELD_DECLARED =
	"You deliver your result with the `yield` tool. The `yield` declared to you is the parent's, kept identical to the parent's request to keep its prompt cache; the one registered in this session takes the parameters below.";

const YIELD_CALL =
	'Emit it as a function call of its own, exactly like a call to `read` or `bash`: name `yield`, arguments `{"data": <your result>}`, or `{"error": "<why>"}` when you cannot finish. Only that call ends your run. Through `eval` (`tool.yield`) it is rejected.';

export function yieldDelta(ownYield: OwnYield | undefined): Delta {
	if (!ownYield) return { kind: "none" };
	const { tool, declared } = ownYield;
	return {
		kind: "text",
		body: [
			`${declared ? YIELD_DECLARED : YIELD_UNDECLARED} ${YIELD_CALL}`,
			"",
			"Description:",
			tool.description,
			"",
			"Parameters (JSON Schema):",
			JSON.stringify(tool.parameters),
		].join("\n"),
	};
}

// The capability layer caches file content per process: read each discovered file from disk.
async function contextFilesUnder(cwd: string): Promise<ContextFile[]> {
	const found = await loadCapability<HostContextFile>(contextFileCapability.id, { cwd });
	const files = await Promise.all(found.items.map((file) => currentContextFile(file.path)));
	return files.filter((file) => file !== undefined);
}

async function currentContextFile(filePath: string): Promise<ContextFile | undefined> {
	const content = await readOptional(filePath);
	return content === undefined ? undefined : { path: filePath, content: await expandAtImports(content, filePath) };
}

export async function cloneDiff(clone: Clone, session: AgentSession): Promise<Delta> {
	const current: ForkCurrent = {
		cwd: clone.cwd,
		tools: session.agent.state.tools.map((tool) => tool.name),
		contextFiles: await contextFilesUnder(clone.cwd.path),
	};
	const restored = [...clone.reported].filter((name) => current.tools.includes(name));
	for (const name of unavailableTools(clone.baseline, current.tools)) clone.reported.add(name);
	return forkDiff(clone.baseline, current, restored);
}
