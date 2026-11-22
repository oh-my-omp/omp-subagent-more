// Relies on omp internals (AgentRegistry, the executor's session-file path and
// hook ordering, session entry types, subagent worker threads); re-verify after
// every omp upgrade.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type {
	AgentDefinition,
	AgentSession,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeSubagentSpawnEvent,
	BeforeSubagentSpawnEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	TaskItem,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { contextFileCapability, type ContextFile as HostContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { expandAtImports } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { generateTaskName, sanitizeAgentId } from "@oh-my-pi/pi-coding-agent/task/name-generator";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents, cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { createDeltaStream, type Delta, type DeltaStream } from "../../omomp-shared/context-delta.ts";
import { tr } from "../../omomp-shared/i18n.ts";
import { callerSession } from "./caller-session.ts";
import { errorText } from "./errors.ts";
import { type ContextFile, type ForkBaseline, type ForkCurrent, forkDiff, unavailableTools, type WorkingDirectory } from "./fork-diff.ts";
import {
	applyReplica,
	captureReplica,
	type ForkNotice,
	liveRequest,
	type OwnYield,
	observedHere,
	observeRequests,
	type ParkedRequest,
	parkedRequest,
	type Replica,
	type SourceRequest,
} from "./replica.ts";
import { readReplicaFile, replicaFilePath, sessionArtifactsDir, writeReplicaFile } from "./replica-file.ts";
import { createReportLimit } from "./report-limit.ts";
import { completeRoles, MEDIUM_EFFORT } from "./role-chain.ts";
import { askSource, serveSources } from "./source-channel.ts";
import { finalizeStaging } from "./staging.ts";
import { registerSubagentProgress } from "./subagent-progress.ts";
import { registerForkTaskTopics } from "./topics.ts";
import {
	applyOverlay,
	type Inheritance,
	inheritSourceWorkspace,
	recordStart,
	rejection,
	workingDirectory,
	writeOverlay,
} from "./workspace.ts";

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
			"Where the child runs: `shared` shares your checkout, `isolated_from_caller` creates a new worktree from your checkout, and `isolated_from_source` creates an isolated worktree seeded with `from`'s uncommitted isolated changes (needs a stopped `from` agent; fails before dispatch if ineligible — see `tool://fork_task/limits`). Defaults to `shared` without `agent` and `isolated_from_caller` with `agent`; plan mode forces `shared`. Isolated children merge changes back on completion and cannot be resumed.",
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

const progressSchema = z.object({ progress: z.array(z.object({ index: z.number(), id: z.string() }).passthrough()) }).passthrough();

export const DESCRIPTION =
	"Fork a live or parked session into native task children sharing its exact request and prompt cache. Read `tool://fork_task/limits` before using `from` or `workspace`.";

type ForkSource =
	| { readonly kind: "caller"; readonly request: SourceRequest; readonly file: string; readonly cwd: string }
	| { readonly kind: "agent"; readonly id: string; readonly request: SourceRequest; readonly file: string; readonly cwd: string }
	| { readonly kind: "parked"; readonly id: string; readonly request: SourceRequest; readonly file: string; readonly cwd: string };

function workspaceNotice(source: ForkSource, parentCwd: string, isolated: boolean, inherited: boolean): string[] {
	switch (source.kind) {
		case "caller":
			return [
				isolated
					? "- You run in an isolated copy of the workspace."
					: "- You share the parent's working directory; files may change between your reads.",
			];
		case "agent":
		case "parked": {
			const id = `\`${source.id}\``;
			return [
				isolated
					? "- You run in an isolated copy of the parent's workspace."
					: `- You share the parent's working directory \`${parentCwd}\`; files may change between your reads.`,
				inherited
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

const forkNotice = (source: ForkSource, parentCwd: string, isolated: boolean, inherited: boolean): string => {
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
		...workspaceNotice(source, parentCwd, isolated, inherited),
		"</system-notice>",
	].join("\n");
};

const FORK_AGENT = "fork:self";

type PendingFork = {
	readonly name: string;
	readonly artifactsDir: string;
	readonly staging: string;
	readonly replica: Replica;
	readonly model: string | string[] | undefined;
	readonly overlay: string | undefined;
};

type StagedFork = {
	readonly staging: string;
	readonly notice: ForkNotice;
	readonly shakeSummary?: string;
};

function allocatedFrom(id: string, name: string): boolean {
	return (/^\d+$/.test(name) ? [name, `Agent${name}`] : [name]).some((base) => {
		if (id === base) return true;
		const suffix = id.startsWith(`${base}-`) ? id.slice(base.length + 1) : "";
		return /^[1-9]\d*$/.test(suffix);
	});
}

function claimsName(pending: readonly PendingFork[], artifactsDir: string, name: string): boolean {
	const lower = name.toLowerCase();
	return pending.some(
		(entry) =>
			entry.artifactsDir === artifactsDir &&
			(allocatedFrom(entry.name.toLowerCase(), lower) || allocatedFrom(lower, entry.name.toLowerCase())),
	);
}

async function moveFile(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
		await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
		await fs.rm(from, { force: true });
	}
}

function lastResponse(manager: SessionManager): number | undefined {
	const branch = manager.getBranchView();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") return entry.message.timestamp;
	}
	return undefined;
}

async function stageFork(
	ctx: ExtensionContext,
	parent: AgentSession,
	artifactsDir: string,
	source: ForkSource,
	shake: boolean,
	isolated: boolean,
	inherited: boolean,
): Promise<StagedFork> {
	const parentCwd = parent.sessionManager.getCwd();
	const stagingDir = path.join(artifactsDir, ".fork-task-staging", randomUUID());
	const staging = path.join(stagingDir, "fork.jsonl");
	await fs.mkdir(stagingDir, { recursive: true });
	try {
		const manager = await SessionManager.forkFrom(source.file, parentCwd, stagingDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile: staging,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		let shakeSummary: string | undefined;
		let preShakeIds: ReadonlySet<string> | undefined;
		let notice: ForkNotice;
		try {
			if (source.kind === "parked" && lastResponse(manager) !== source.request.response) {
				throw new Error(
					`agent \`${source.id}\`'s transcript has moved past the request it kept at park, or is still being written while it parks; retry the fork.`,
				);
			}
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
			const timestamp = Date.now();
			const entryId = manager.appendMessage({
				role: "developer",
				content: forkNotice(source, parentCwd, isolated, inherited),
				attribution: "agent",
				timestamp,
			});
			notice = { entryId, timestamp };
			await manager.flush();
			if (shake) {
				preShakeIds = new Set(manager.getEntries().map((entry) => entry.id));
				const parentArtifacts = parent.sessionManager.getArtifactManager();
				if (parentArtifacts) manager.adoptArtifactManager(parentArtifacts);
				const { session: shaker } = await createAgentSession({
					cwd: parentCwd,
					sessionManager: manager,
					model: parent.model ?? ctx.model,
					modelRegistry: ctx.modelRegistry,
					toolNames: [],
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					disableExtensionDiscovery: true,
					systemPrompt: [],
					hasUI: false,
					// A main-kind session's dispose tears down the global
					// AgentLifecycleManager; keep the helper out of the shared registry.
					taskDepth: 1,
					agentRegistry: new AgentRegistry(),
					agentId: `fork-shake-${path.basename(stagingDir)}`,
				});
				try {
					const result = await shaker.shake("elide");
					shakeSummary = `shake freed ~${result.tokensFreed} tokens (${result.toolResultsDropped} tool results, ${result.blocksDropped} blocks)`;
				} finally {
					await shaker.dispose();
				}
			}
		} finally {
			await manager.close();
		}
		await finalizeStaging(staging, { cwd: parentCwd, isolated, preShakeIds });
		return { staging, notice, shakeSummary };
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

type SourceResolution = { readonly kind: "error"; readonly message: string } | ForkSource;

async function resolveSource(from: string | undefined, parent: AgentSession, parentFile: string): Promise<SourceResolution> {
	const requested = from?.trim();
	const caller = async (): Promise<SourceResolution> => {
		const live = liveRequest(parent);
		if (live.kind === "unavailable") return { kind: "error", message: `cannot replicate your own request: ${live.reason}` };
		await parent.sessionManager.flush();
		return { kind: "caller", request: live.source, file: parentFile, cwd: parent.sessionManager.getCwd() };
	};
	if (!requested) return caller();
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, parentFile);
	let ref = registry.get(requested);
	if (ref?.kind === "advisor") ref = undefined;
	const lower = requested.toLowerCase();
	ref ??= registry.list().find((candidate) => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower);
	if (!ref) return { kind: "error", message: `no agent \`${requested}\` is registered; \`from\` takes an id as in \`agent://<id>\`.` };
	if (ref.session === parent || ref.sessionFile === parentFile) return caller();
	const parked = (id: string, file: string, kept: ParkedRequest): SourceResolution => {
		const { cwd, ...request } = kept;
		return { kind: "parked", id, request, file, cwd };
	};
	const session = ref.session;
	if (!session) {
		const kept = ref.sessionFile ? await parkedRequest(ref.sessionFile) : undefined;
		if (!ref.sessionFile || !kept) {
			return {
				kind: "error",
				message: `agent \`${ref.id}\` is parked and OMP kept no request of it (it parked in an earlier OMP process, or its last request got no response); wake it with \`write agent://${ref.id}\`, then fork it.`,
			};
		}
		return parked(ref.id, ref.sessionFile, kept);
	}
	if (isLocalAgentSession(session) && observedHere(session)) {
		const live = liveRequest(session);
		if (live.kind === "unavailable") return { kind: "error", message: `cannot replicate the source's request: ${live.reason}` };
		await session.sessionManager.ensureOnDisk();
		await session.sessionManager.flush();
		const file = session.sessionManager.getSessionFile();
		if (!file) return { kind: "error", message: `agent \`${ref.id}\` has no persisted transcript to fork.` };
		return { kind: "agent", id: ref.id, request: live.source, file, cwd: session.sessionManager.getCwd() };
	}
	const file = ref.sessionFile ?? session.sessionManager.getSessionFile();
	if (!file) return { kind: "error", message: `agent \`${ref.id}\` has no persisted transcript to fork.` };
	const shared = await askSource(file);
	if (!shared) {
		const kept = await parkedRequest(file);
		if (kept) return parked(ref.id, file, kept);
		return { kind: "error", message: `agent \`${ref.id}\` runs in another OMP thread that did not answer for it; retry the fork.` };
	}
	if (shared.kind === "unavailable") return { kind: "error", message: `cannot replicate the source's request: ${shared.reason}` };
	const { cwd, ...request } = shared.source;
	return { kind: "agent", id: ref.id, request, file, cwd };
}

type RoleResolution =
	| { readonly kind: "none" }
	| {
			readonly kind: "role";
			readonly block: string;
			readonly model: string | string[] | undefined;
			readonly output: AgentDefinition["output"];
	  }
	| { readonly kind: "error"; readonly message: string };

function roleResolver(parent: AgentSession): (agent: string | undefined) => Promise<RoleResolution> {
	let definitions: Promise<AgentDefinition[]> | undefined;
	return async (agent) => {
		if (!agent) return { kind: "none" };
		if (agent === FORK_AGENT)
			return { kind: "error", message: `\`${FORK_AGENT}\` is internal; omit \`agent\` to keep the source's model.` };
		if (cfgTaskDisabledAgents.get(parent.settings).includes(agent)) {
			return { kind: "error", message: `agent \`${agent}\` is disabled by \`task.disabledAgents\`.` };
		}
		definitions ??= discoverAgents(parent.sessionManager.getCwd(), os.homedir(), parent.effectiveExtensionRoots).then(({ agents }) => [
			...agents,
			...parent.getSessionAgents(),
		]);
		const definition = getAgent(await definitions, agent);
		if (!definition) return { kind: "error", message: `no agent definition named \`${agent}\`.` };
		const override = cfgTaskAgentModelOverrides.get(parent.settings)[agent];
		return {
			kind: "role",
			block: `<role agent="${agent}">\n${definition.systemPrompt.trim()}\n</role>`,
			model: override ?? definition.model,
			output: definition.output,
		};
	};
}

async function sourceInheritance(source: ForkSource, isolated: boolean, callerCwd: string): Promise<Inheritance> {
	if (!isolated) {
		return {
			kind: "rejected",
			code: "child-not-isolated",
			detail: 'the child would share your workspace (explicit `workspace: "shared"`, or plan mode); inheriting needs an isolated child.',
		};
	}
	switch (source.kind) {
		case "caller":
			return {
				kind: "rejected",
				code: "source-not-isolated",
				detail: "without `from` the source is your own conversation, which has no isolated workspace of its own; name the agent in `from`.",
			};
		case "agent":
		case "parked": {
			const ref = AgentRegistry.global().get(source.id);
			return inheritSourceWorkspace(
				{
					id: source.id,
					file: source.file,
					cwd: source.cwd,
					running: ref?.status === "running",
					handedBack: ref?.history?.patchPath !== undefined || ref?.history?.branchName !== undefined,
				},
				callerCwd,
			);
		}
		default: {
			const unreachable: never = source;
			return unreachable;
		}
	}
}

/** A replicated child: its own `yield`, what its request carries from the source, and the tools it was told are unavailable. */
type Clone = {
	readonly ownYield: OwnYield | undefined;
	readonly baseline: ForkBaseline;
	/** The child's own working directory; a session keeps its cwd for its whole run. */
	readonly cwd: WorkingDirectory;
	readonly reported: Set<string>;
};

type ForkTaskRuntime = {
	readonly pi: ExtensionAPI;
	readonly warn: (message: string, error: unknown) => void;
	readonly pending: PendingFork[];
	readonly cloned: WeakMap<AgentSession, Clone>;
	readonly deltas: DeltaStream;
	readonly diffs: DeltaStream;
	readonly started: Set<string>;
};

async function discardPending(rt: ForkTaskRuntime, entry: PendingFork): Promise<void> {
	const index = rt.pending.indexOf(entry);
	if (index !== -1) rt.pending.splice(index, 1);
	const stagingDir = path.dirname(entry.staging);
	await fs.rm(stagingDir, { recursive: true, force: true });
	await fs.rmdir(path.dirname(stagingDir)).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && (error.code === "ENOTEMPTY" || error.code === "ENOENT")) return;
		throw error;
	});
}

async function beforeSubagentSpawn(
	rt: ForkTaskRuntime,
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
): Promise<BeforeSubagentSpawnEventResult | undefined> {
	if (event.invocationKind !== "task" || event.agent !== FORK_AGENT || !event.spawnKey) return;
	const callerFile = ctx.sessionManager.getSessionFile();
	if (!callerFile) return;
	const artifactsDir = sessionArtifactsDir(callerFile);
	const spawnKey = event.spawnKey;
	const segment = spawnKey.slice(spawnKey.lastIndexOf(".") + 1);
	const forks = rt.pending.filter((p) => p.artifactsDir === artifactsDir);
	const entry = forks.find((p) => p.name === segment) ?? forks.find((p) => allocatedFrom(segment, p.name));
	if (!entry) return;
	const target = path.join(artifactsDir, `${spawnKey}.jsonl`);
	try {
		const occupied = await fs.access(target).then(
			() => true,
			() => false,
		);
		if (occupied) {
			await discardPending(rt, entry);
			return { block: true, reason: `fork_task: ${target} already exists; refusing to overwrite it.` };
		}
		await fs.mkdir(artifactsDir, { recursive: true });
		await moveFile(entry.staging, target);
		await discardPending(rt, entry);
		await writeReplicaFile(replicaFilePath(target), entry.replica);
		if (entry.overlay) await writeOverlay(target, entry.overlay);
		return entry.model === undefined ? undefined : { model: entry.model };
	} catch (error) {
		rt.pi.logger.warn("fork_task: preparing the child conversation failed", { error: errorText(error) });
		return { block: true, reason: `fork_task: preparing the child conversation failed: ${errorText(error)}` };
	}
}

const YIELD_UNDECLARED =
	"You deliver your result with the `yield` tool. It is not among the tools declared to you, because the declaration stays identical to the parent's request to keep its prompt cache; it is registered in this session all the same.";

const YIELD_DECLARED =
	"You deliver your result with the `yield` tool. The `yield` declared to you is the parent's, kept identical to the parent's request to keep its prompt cache; the one registered in this session takes the parameters below.";

const YIELD_CALL =
	'Emit it as a function call of its own, exactly like a call to `read` or `bash`: name `yield`, arguments `{"data": <your result>}`, or `{"error": "<why>"}` when you cannot finish. Only that call ends your run. Through `eval` (`tool.yield`) it is rejected.';

function yieldDelta(ownYield: OwnYield | undefined): Delta {
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

function toolResult(rt: ForkTaskRuntime, ctx: ExtensionContext): { additionalContext: string } | undefined {
	const session = callerSession(ctx);
	const clone = session && rt.cloned.get(session);
	if (!clone) return;
	return rt.deltas.afterTools(ctx, yieldDelta(clone.ownYield));
}

/**
 * The context files OMP discovers for `cwd`, `@path` imports expanded as the system prompt builder does.
 * Plugins reach only the served `capability` and `discovery` modules, not the builder itself.
 * The capability layer caches file content for the whole process, so each file's content is read
 * from disk here; a file deleted since its discovery is not under `cwd` any more.
 */
async function contextFilesUnder(cwd: string): Promise<ContextFile[]> {
	const found = await loadCapability<HostContextFile>(contextFileCapability.id, { cwd });
	const files = await Promise.all(found.items.map((file) => currentContextFile(file.path)));
	return files.filter((file) => file !== undefined);
}

async function currentContextFile(filePath: string): Promise<ContextFile | undefined> {
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	return { path: filePath, content: await expandAtImports(content, filePath) };
}

async function cloneDiff(clone: Clone, session: AgentSession): Promise<Delta> {
	const current: ForkCurrent = {
		cwd: clone.cwd,
		tools: session.agent.state.tools.map((tool) => tool.name),
		contextFiles: await contextFilesUnder(clone.cwd.path),
	};
	const restored = [...clone.reported].filter((name) => current.tools.includes(name));
	for (const name of unavailableTools(clone.baseline, current.tools)) clone.reported.add(name);
	return forkDiff(clone.baseline, current, restored);
}

/** The current difference of the calling session when it is a replicated child; undefined otherwise or when computing it failed. */
async function currentDiff(rt: ForkTaskRuntime, ctx: ExtensionContext): Promise<Delta | undefined> {
	const session = callerSession(ctx);
	const clone = session && rt.cloned.get(session);
	if (!session || !clone) return;
	try {
		return await cloneDiff(clone, session);
	} catch (error) {
		rt.warn("fork_task: computing the fork child's differences failed", error);
		return;
	}
}

async function diffAtPrompt(rt: ForkTaskRuntime, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined> {
	const delta = await currentDiff(rt, ctx);
	return delta && rt.diffs.atPrompt(ctx, delta);
}

async function diffAfterTools(rt: ForkTaskRuntime, ctx: ExtensionContext): Promise<{ additionalContext: string } | undefined> {
	const delta = await currentDiff(rt, ctx);
	return delta && rt.diffs.afterTools(ctx, delta);
}

async function beforeAgentStart(
	rt: ForkTaskRuntime,
	_event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
	const session = callerSession(ctx);
	if (!session) return;
	// A cloned session already holds its replica in the stream hook: never re-read the copy for it.
	const clone = rt.cloned.get(session);
	if (clone) return rt.deltas.atPrompt(ctx, yieldDelta(clone.ownYield));
	const file = ctx.sessionManager.getSessionFile();
	if (ctx.agent.kind === "sub" && file && !rt.started.has(file)) {
		rt.started.add(file);
		const cwd = ctx.sessionManager.getCwd();
		await recordStart(file, cwd, ctx.agent.id).catch((error: unknown) => rt.warn("fork_task: recording the workspace start failed", error));
		let failure: string | undefined;
		try {
			const overlay = await applyOverlay(file, cwd);
			if (overlay.kind === "failed") failure = overlay.message;
		} catch (error) {
			failure = errorText(error);
		}
		if (failure !== undefined) {
			const reason = rejection("overlay-conflict", `the inherited changes did not apply to this workspace: ${failure}`);
			rt.pi.logger.warn(`fork_task: ${reason}`);
			// The assignment assumes the inherited changes; do not run it without them.
			session.agent.addBeforeModelCallHook(() => {
				throw new Error(reason);
			});
			return;
		}
	}
	try {
		observeRequests(session, rt.warn);
		const replica = file ? await readReplicaFile(replicaFilePath(file)) : undefined;
		if (!replica) {
			if (ctx.agent.name === FORK_AGENT) {
				throw new Error("the fork's request snapshot is no longer available; create a fresh fork from the parent");
			}
			return;
		}
		const ownYield = applyReplica(session, replica);
		const [sourceCwd, ownCwd] = await Promise.all([workingDirectory(replica.cwd), workingDirectory(ctx.sessionManager.getCwd())]);
		rt.cloned.set(session, {
			ownYield,
			baseline: {
				cwd: sourceCwd,
				tools: replica.request.context.tools?.map((tool) => tool.name) ?? [],
				contextFiles: replica.contextFiles,
			},
			cwd: ownCwd,
			reported: new Set(),
		});
		return rt.deltas.atPrompt(ctx, yieldDelta(ownYield));
	} catch (error) {
		const reason = `fork_task: preparing request replication failed: ${errorText(error)}`;
		rt.pi.logger.warn(reason);
		// Do not run a different child contract after replication failed.
		session.agent.addBeforeModelCallHook(() => {
			throw new Error(reason);
		});
	}
}

async function sessionShutdown(rt: ForkTaskRuntime, _event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> {
	const parentFile = ctx.sessionManager.getSessionFile();
	if (!parentFile) return;
	rt.started.delete(parentFile);
	const artifactsDir = sessionArtifactsDir(parentFile);
	for (const entry of rt.pending.filter((p) => p.artifactsDir === artifactsDir)) {
		try {
			await discardPending(rt, entry);
		} catch (error) {
			rt.pi.logger.warn("fork_task: cleaning up the staged conversation failed", { error: errorText(error) });
		}
	}
}

export type ForkWorkspace = "shared" | "isolated_from_caller" | "isolated_from_source";

export function resolveForkWorkspace(
	requested: ForkWorkspace | undefined,
	hasRole: boolean,
	planMode: boolean,
): { readonly workspace: ForkWorkspace; readonly isolated: boolean } {
	const workspace: ForkWorkspace = requested ?? (hasRole ? "isolated_from_caller" : "shared");
	return { workspace, isolated: !planMode && workspace !== "shared" };
}

async function executeForkTask(
	rt: ForkTaskRuntime,
	toolCallId: string,
	rawParams: unknown,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
	const staged: PendingFork[] = [];
	const discardStaged = async (): Promise<void> => {
		for (const entry of staged) {
			try {
				await discardPending(rt, entry);
			} catch (cleanupError) {
				rt.pi.logger.warn("fork_task: cleaning up the staged conversation failed", { error: errorText(cleanupError) });
			}
		}
	};
	try {
		const params = paramsSchema.parse(rawParams);
		const parent = callerSession(ctx);
		if (!parent) return fail(`fork_task: agent \`${ctx.agent.id}\` has no session in the agent registry.`);
		const maxRecursionDepth = cfgTaskMaxRecursionDepth.get(parent.settings);
		const callerDepth = ctx.agent.depth;
		if (maxRecursionDepth >= 0 && callerDepth + 1 >= maxRecursionDepth) {
			return fail(
				`fork_task: reached the maximum dispatch depth (current taskDepth ${callerDepth}, task.maxRecursionDepth ${maxRecursionDepth}); a forked child would start at the cap and cannot dispatch subagents.`,
			);
		}
		const taskTool = parent.getToolByName("task");
		if (!taskTool) return fail("fork_task: the `task` tool is unavailable in this session (recursion depth or settings).");
		if (!parent.asyncJobManager || cfgAsyncEnabled.get(parent.settings) !== true) {
			return fail("fork_task: requires background jobs (`async.enabled: true`).");
		}
		await parent.sessionManager.ensureOnDisk();
		await parent.sessionManager.flush();
		const parentFile = parent.sessionManager.getSessionFile();
		if (!parentFile) return fail("fork_task: forking needs a persisted session.");
		// The host places a child beside its caller's own transcript (`leaseArtifacts`);
		// `getArtifactsDir()` of a subagent names the root's adopted store instead.
		const artifactsDir = sessionArtifactsDir(parentFile);
		const planMode = parent.getPlanModeState()?.enabled === true;

		const notes: string[] = [];
		const tasks: TaskItem[] = [];
		const resolveRole = roleResolver(parent);
		let refused: string | undefined;
		try {
			for (const [index, item] of params.tasks.entries()) {
				const source = await resolveSource(item.from, parent, parentFile);
				if (source.kind === "error") throw new Error(source.message);
				const agent = item.agent?.trim() || undefined;
				const role = await resolveRole(agent);
				if (role.kind === "error") throw new Error(role.message);
				// Absent both, the host falls back to `fork:self`'s own `output`.
				const outputSchema = item.outputSchema ?? (role.kind === "role" ? role.output : undefined);
				const captured = captureReplica(
					{ ...source.request, cwd: source.cwd },
					{
						inheritReasoning: role.kind === "none" && item.effort === undefined,
					},
				);
				const requested = sanitizeAgentId(item.name);
				let name = requested ?? generateTaskName();
				while (requested === undefined && claimsName(rt.pending, artifactsDir, name)) name = generateTaskName();
				if (claimsName(rt.pending, artifactsDir, name)) {
					throw new Error(`a fork named \`${name}\` of this session is still being dispatched; give tasks[${index}] another \`name\`.`);
				}
				const { workspace, isolated } = resolveForkWorkspace(item.workspace, role.kind === "role", planMode);
				const inheritance =
					workspace === "isolated_from_source" ? await sourceInheritance(source, isolated, parent.sessionManager.getCwd()) : undefined;
				if (inheritance?.kind === "rejected") {
					refused = rejection(inheritance.code, inheritance.detail);
					break;
				}
				const shake = item.shake === true;
				const { staging, notice, shakeSummary } = await stageFork(
					ctx,
					parent,
					artifactsDir,
					source,
					shake,
					isolated,
					inheritance !== undefined,
				);
				const { response, ...capture } = captured;
				const entry: PendingFork = {
					name,
					artifactsDir,
					staging,
					replica: { ...capture, replay: shake ? { kind: "own" } : { kind: "prefix", response, notice } },
					model: role.kind === "role" ? role.model : capture.sourceModel,
					overlay: inheritance?.patch,
				};
				staged.push(entry);
				rt.pending.push(entry);
				if (shakeSummary) notes.push(`${name}: ${shakeSummary}`);
				tasks[index] = {
					name,
					task: [role.kind === "role" ? role.block : "", params.context.trim(), item.task].filter((part) => part.length > 0).join("\n\n"),
					agent: FORK_AGENT,
					...(planMode ? {} : { isolated }),
					...(item.effort !== undefined ? { effort: item.effort } : {}),
					...(outputSchema !== undefined ? { outputSchema } : {}),
					...(item.schemaMode !== undefined ? { schemaMode: item.schemaMode } : {}),
				};
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new Error(`staging the conversation fork failed: ${errorText(error)}`, { cause: error });
		}
		if (refused !== undefined) {
			await discardStaged();
			return fail(refused);
		}

		const result = await taskTool.execute(toolCallId, { context: params.context, tasks }, signal, onUpdate);

		const parsed = progressSchema.safeParse(result.details);
		const scheduled = new Set(parsed.success ? parsed.data.progress.map((p) => p.index) : []);
		for (const [index, entry] of staged.entries()) {
			if (!scheduled.has(index)) await discardPending(rt, entry);
		}

		if (notes.length === 0) return result;
		return {
			...result,
			content: [...result.content, { type: "text" as const, text: `\n[fork_task] ${notes.join("; ")}` }],
		};
	} catch (error) {
		await discardStaged();
		if (signal?.aborted) throw error;
		rt.pi.logger.warn("fork_task: executing the conversation fork failed", { error: errorText(error) });
		return fail(`fork_task: ${errorText(error)}`);
	}
}

const REPORT_LIMIT_ROLE = "omp-subagent-more";

export default function forkTask(pi: ExtensionAPI): void {
	const warn = (message: string, error: unknown) => pi.logger.warn(message, { error: errorText(error) });
	serveSources(warn);
	const rt: ForkTaskRuntime = {
		pi,
		warn,
		pending: [],
		cloned: new WeakMap(),
		deltas: createDeltaStream("omp-subagent-more/fork-task"),
		diffs: createDeltaStream("omp-subagent-more/fork-diff"),
		started: new Set(),
	};

	pi.on("before_subagent_spawn", beforeSubagentSpawn.bind(null, rt));
	pi.on("before_agent_start", beforeAgentStart.bind(null, rt));
	// Registered after `beforeAgentStart`, which records the clone this handler reads.
	pi.on("before_agent_start", (_event, ctx) => diffAtPrompt(rt, ctx));
	pi.on("tool_result", (_event, ctx) => toolResult(rt, ctx));
	pi.on("tool_result", (_event, ctx) => diffAfterTools(rt, ctx));
	pi.on("session_shutdown", sessionShutdown.bind(null, rt));
	pi.on("turn_start", () => {
		rt.deltas.turnStarted();
		rt.diffs.turnStarted();
	});
	registerSubagentProgress(pi, warn);
	const reportLimit = createReportLimit({
		info: (message, data) => pi.logger.info(message, data),
		warn: (message, data) => pi.logger.warn(message, data),
	});
	// A throwing tool_call handler blocks the tool, so every failure lets the call run.
	pi.on("tool_call", async (event, ctx) => {
		try {
			const reason = await reportLimit.inspect(event.toolName, event.input, async (systemPrompt, prompt, signal, deadlineAt) => {
				const reply = await completeRoles(ctx, [REPORT_LIMIT_ROLE, "default"], systemPrompt, prompt, MEDIUM_EFFORT, deadlineAt, signal);
				switch (reply.kind) {
					case "text":
						pi.logger.info("omp-subagent-more report-limit answered", { model: reply.model, failures: reply.failures });
						return { kind: "text", text: reply.text };
					case "no-model":
						return { kind: "failed", why: `no model: assign @${REPORT_LIMIT_ROLE} or the default role in /model` };
					case "deadline":
						return { kind: "failed", why: "deadline" };
					case "all-failed":
						return { kind: "failed", why: `every model failed: ${reply.failures.join("; ")}` };
					case "error":
						return { kind: "failed", why: reply.error };
					default: {
						const unreachable: never = reply;
						return unreachable;
					}
				}
			});
			return reason === null ? undefined : { block: true, reason };
		} catch (error) {
			warn("omp-subagent-more report-limit skipped a fork_task call", error);
			return undefined;
		}
	});

	registerForkTaskTopics();
	const tool: ToolDefinition<typeof paramsSchema> = {
		name: "fork_task",
		label: tr("Fork Task", "分叉任务"),
		description: DESCRIPTION,
		loadMode: "essential",
		parameters: paramsSchema,
		execute: executeForkTask.bind(null, rt),
	};
	pi.registerTool(tool);
}
