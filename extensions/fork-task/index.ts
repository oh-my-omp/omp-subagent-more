// Relies on omp internals (AgentRegistry, the executor's session-file path and
// hook ordering, session entry types, subagent worker threads); re-verify after
// every omp upgrade.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type {
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
import { generateTaskName, sanitizeAgentId } from "@oh-my-pi/pi-coding-agent/task/name-generator";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { createDeltaStream, type Delta, type DeltaStream } from "../../omomp-shared/context-delta.ts";
import { tr } from "../../omomp-shared/i18n.ts";
import { callerSession } from "./caller-session.ts";
import { type Clone, cloneDiff, yieldDelta } from "./clone.ts";
import { errorText } from "./errors.ts";
import { applyReplica, captureReplica, observeRequests } from "./replica.ts";
import { readReplicaFile, replicaFilePath, sessionArtifactsDir, writeReplicaFile } from "./replica-file.ts";
import { registerReportLimit } from "./report-limit.ts";
import { FORK_AGENT, type RoleResolver, roleResolver } from "./role.ts";
import { DESCRIPTION, type ForkItem, paramsSchema } from "./schema.ts";
import { placeWorkspace, resolveSource } from "./source.ts";
import { serveSources } from "./source-channel.ts";
import { allocatedFrom, claimsName, discardPending, moveFile, type PendingFork, stageFork } from "./stage.ts";
import { registerSubagentProgress } from "./subagent-progress.ts";
import { docTopics, registerForkTaskTopics } from "./topics.ts";
import { applyOverlay, recordStart, rejection, resolveForkWorkspace, workingDirectory, writeOverlay } from "./workspace.ts";

const progressSchema = z.object({ progress: z.array(z.object({ index: z.number(), id: z.string() }).passthrough()) }).passthrough();

type ForkTaskRuntime = {
	readonly pi: ExtensionAPI;
	readonly warn: (message: string, error: unknown) => void;
	readonly pending: PendingFork[];
	readonly cloned: WeakMap<AgentSession, Clone>;
	readonly deltas: DeltaStream;
	readonly diffs: DeltaStream;
	readonly started: Set<string>;
};

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
			await discardPending(rt.pending, entry);
			return { block: true, reason: `fork_task: ${target} already exists; refusing to overwrite it.` };
		}
		await fs.mkdir(artifactsDir, { recursive: true });
		await moveFile(entry.staging, target);
		await discardPending(rt.pending, entry);
		await writeReplicaFile(replicaFilePath(target), entry.replica);
		if (entry.overlay) await writeOverlay(target, entry.overlay);
		return entry.model === undefined ? undefined : { model: entry.model };
	} catch (error) {
		rt.pi.logger.warn("fork_task: preparing the child conversation failed", { error: errorText(error) });
		return { block: true, reason: `fork_task: preparing the child conversation failed: ${errorText(error)}` };
	}
}

function cloneOf(rt: ForkTaskRuntime, ctx: ExtensionContext): { readonly session: AgentSession; readonly clone: Clone } | undefined {
	const session = callerSession(ctx);
	const clone = session && rt.cloned.get(session);
	return session && clone ? { session, clone } : undefined;
}

function toolResult(rt: ForkTaskRuntime, ctx: ExtensionContext): { additionalContext: string } | undefined {
	const found = cloneOf(rt, ctx);
	return found && rt.deltas.afterTools(ctx, yieldDelta(found.clone.ownYield));
}

async function currentDiff(rt: ForkTaskRuntime, ctx: ExtensionContext): Promise<Delta | undefined> {
	const found = cloneOf(rt, ctx);
	if (!found) return;
	try {
		return await cloneDiff(found.clone, found.session);
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

function refuseModelCalls(session: AgentSession, reason: string): void {
	session.agent.addBeforeModelCallHook(() => {
		throw new Error(reason);
	});
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
		const failure = await applyOverlay(file, cwd).then(
			(overlay) => (overlay.kind === "failed" ? overlay.message : undefined),
			(error: unknown) => errorText(error),
		);
		if (failure !== undefined) {
			const reason = rejection("overlay-conflict", `the inherited changes did not apply to this workspace: ${failure}`);
			rt.pi.logger.warn(`fork_task: ${reason}`);
			// The assignment assumes the inherited changes; do not run it without them.
			refuseModelCalls(session, reason);
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
		refuseModelCalls(session, reason);
	}
}

async function discardAll(rt: ForkTaskRuntime, entries: readonly PendingFork[]): Promise<void> {
	for (const entry of entries) {
		try {
			await discardPending(rt.pending, entry);
		} catch (error) {
			rt.pi.logger.warn("fork_task: cleaning up the staged conversation failed", { error: errorText(error) });
		}
	}
}

async function sessionShutdown(rt: ForkTaskRuntime, _event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> {
	const parentFile = ctx.sessionManager.getSessionFile();
	if (!parentFile) return;
	rt.started.delete(parentFile);
	const artifactsDir = sessionArtifactsDir(parentFile);
	await discardAll(
		rt,
		rt.pending.filter((p) => p.artifactsDir === artifactsDir),
	);
}

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
		const batch: Batch = {
			ctx,
			parent,
			parentFile,
			// The host places a child beside its caller's own transcript (`leaseArtifacts`);
			// `getArtifactsDir()` of a subagent names the root's adopted store instead.
			artifactsDir: sessionArtifactsDir(parentFile),
			planMode: parent.getPlanModeState()?.enabled === true,
			context: params.context,
			resolveRole: roleResolver(parent),
		};
		const notes: string[] = [];
		const tasks: TaskItem[] = [];
		try {
			for (const [index, item] of params.tasks.entries()) {
				const result = await stageItem(rt, batch, item, index);
				if (result.kind === "refused") {
					await discardAll(rt, staged);
					return fail(result.reason);
				}
				staged.push(result.entry);
				rt.pending.push(result.entry);
				tasks.push(result.task);
				if (result.note) notes.push(result.note);
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new Error(`staging the conversation fork failed: ${errorText(error)}`, { cause: error });
		}

		const result = await taskTool.execute(toolCallId, { context: params.context, tasks }, signal, onUpdate);

		const parsed = progressSchema.safeParse(result.details);
		const scheduled = new Set(parsed.success ? parsed.data.progress.map((p) => p.index) : []);
		for (const [index, entry] of staged.entries()) {
			if (!scheduled.has(index)) await discardPending(rt.pending, entry);
		}

		if (notes.length === 0) return result;
		return {
			...result,
			content: [...result.content, { type: "text" as const, text: `\n[fork_task] ${notes.join("; ")}` }],
		};
	} catch (error) {
		await discardAll(rt, staged);
		if (signal?.aborted) throw error;
		rt.pi.logger.warn("fork_task: executing the conversation fork failed", { error: errorText(error) });
		return fail(`fork_task: ${errorText(error)}`);
	}
}

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
	registerReportLimit(pi);

	registerForkTaskTopics();
	const tool: ToolDefinition<typeof paramsSchema> & { docTopics(): Readonly<Record<string, string>> } = {
		name: "fork_task",
		label: tr("Fork Task", "分叉任务"),
		description: DESCRIPTION,
		loadMode: "essential",
		parameters: paramsSchema,
		docTopics,
		execute: executeForkTask.bind(null, rt),
	};
	pi.registerTool(tool);
}
