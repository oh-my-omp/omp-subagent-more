// The `flow` tool: the store of prototype/flow behind one OMP tool, and the effects the store
// leaves to its host. Load it into a session with `omp -e prototype/flow/host.ts`.
//
// One flow belongs to one session; its log is `flow.jsonl` among the session's own files.
//
// While a flow runs, one background job of the calling session drives it: it starts what the
// store says is ready, records how each session ended, and settles when the flow stops or
// comes to rest. Its result is the store's verdict, so the caller is woken once per stop, not
// once per session. The sessions themselves are spawned through the session's `task` tool,
// one fresh subagent each; their own completion notices are acknowledged here, since the store
// is what reads them.
//
// A session of an isolated box starts from what the last ended session of the same item left
// and did not hand back: the patch OMP kept when it released that run, or the changes in its
// still-open workspace. The changes travel the way fork_task's `workspace: "source"` does: an
// overlay written at spawn and applied before the child's first turn. Every agent item also
// has a notes file of its own beside the log, which only sessions of that item are told about.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentSession,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeSubagentSpawnEvent,
	type BeforeSubagentSpawnEventResult,
	type ExtensionAPI,
	type ExtensionContext,
	type TaskItem,
	type ToolDefinition,
	z,
} from "@oh-my-pi/pi-coding-agent";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	cfgTaskAgentModelOverrides,
	cfgTaskDisabledAgents,
	cfgTaskIsolationApply,
	cfgTaskIsolationEnabled,
} from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { Shell } from "@oh-my-pi/pi-natives";
import { callerSession } from "../../extensions/fork-task/caller-session.ts";
import { errorText } from "../../extensions/fork-task/errors.ts";
import { tr } from "../../extensions/fork-task/i18n.ts";
import {
	applyOverlay,
	headerCwd,
	type Inheritance,
	inheritReleasedPatch,
	inheritSourceWorkspace,
	recordStart,
	writeOverlay,
} from "../../extensions/fork-task/workspace.ts";
import { type AgentBox, type CommandBox, fill, isObject, type Json, parseJson, type Result, shellWord } from "./defs.ts";
import { DESCRIPTION, flowTopics } from "./docs.ts";
import { appendLog, readLog } from "./journal.ts";
import { type Firing, lookup } from "./plan.ts";
import { briefOf, interpret, yieldSchema } from "./session.ts";
import { definitionKey, type Earlier, modelKey, type Outcome, partsOf } from "./state.ts";
import { type Command, Store } from "./store.ts";

const OPS = ["define", "supply", "run", "stop", "status", "value", "retract", "keep", "retry", "answer"] as const;
type Op = (typeof OPS)[number];

const paramsSchema = z.object({
	op: z
		.enum(OPS)
		.describe(
			"What to do. `define`: add, replace or drop boxes. `supply`: give an outside input its value. `run`: start the flow or resume a stopped one. `stop`: stop a running flow. `status`: report the whole state. `value`: read stored values. `retract`: remove items or inputs and what was computed from them. `keep`: let stale items stand. `retry`: let failed items fire again unchanged. `answer`: answer an item's raise.",
		),
	boxes: z
		.string()
		.optional()
		.describe(
			"JSON text of an object mapping box names to box definitions; `null` drops a box. Required by `define`, which takes nothing else.",
		),
	name: z.string().optional().describe("Name of the outside input, the `<name>` of `input.<name>`. Required by `supply`."),
	value: z
		.string()
		.optional()
		.describe("JSON text of a value. Required by `supply` (the input's value) and by `answer` (the answer to the raise)."),
	keys: z
		.array(z.string())
		.optional()
		.describe(
			"Keys as verdicts print them: an item (`scout`, `work#1`, `answer<work#1@1>`), and for `retract` and `value` also `input.<name>`; `value` takes a box name too. Required by `value`, `retract`, `keep` and `retry`; `answer` takes exactly one.",
		),
	reason: z.string().optional().describe("Why the flow is stopped; recorded with the stop. Only with `stop`. Optional."),
});
type Params = z.infer<typeof paramsSchema>;

const progressSchema = z.object({ progress: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();

type Request =
	| { readonly kind: "command"; readonly command: Command }
	| { readonly kind: "status" }
	| { readonly kind: "value"; readonly keys: readonly string[] };

/** The fields each `op` takes besides `op`; the value says whether the field is required. */
const FIELDS: Record<Op, Partial<Record<"boxes" | "name" | "value" | "keys" | "reason", "required" | "optional">>> = {
	define: { boxes: "required" },
	supply: { name: "required", value: "required" },
	run: {},
	stop: { reason: "optional" },
	status: {},
	value: { keys: "required" },
	retract: { keys: "required" },
	keep: { keys: "required" },
	retry: { keys: "required" },
	answer: { keys: "required", value: "required" },
};

function parseRequest(params: Params): Result<Request> {
	const problems: string[] = [];
	const allowed = FIELDS[params.op];
	for (const field of ["boxes", "name", "value", "keys", "reason"] as const) {
		if (params[field] !== undefined && allowed[field] === undefined) problems.push(`\`${field}\` does not belong to \`${params.op}\``);
		if (params[field] === undefined && allowed[field] === "required") problems.push(`\`${params.op}\` needs \`${field}\``);
	}
	const json = (field: "boxes" | "value"): Json => {
		const parsed = parseJson(params[field] ?? "null");
		if (parsed.ok) return parsed.value;
		problems.push(...parsed.problems.map((problem) => `\`${field}\`: ${problem}`));
		return null;
	};
	const keys = params.keys ?? [];
	const command = (value: Command): Request => ({ kind: "command", command: value });
	let request: Request;
	switch (params.op) {
		case "define": {
			const boxes = json("boxes");
			if (!isObject(boxes)) problems.push("`boxes` is a JSON object of box names to boxes");
			request = command({ kind: "define", boxes: isObject(boxes) ? boxes : {} });
			break;
		}
		case "supply":
			request = command({ kind: "supply", name: params.name ?? "", value: json("value") });
			break;
		case "run":
			request = command({ kind: "run" });
			break;
		case "stop":
			request = command({
				kind: "stop",
				reason: params.reason === undefined ? "stopped by the caller" : `stopped by the caller: ${params.reason}`,
			});
			break;
		case "status":
			request = { kind: "status" };
			break;
		case "value":
			request = { kind: "value", keys };
			break;
		case "retract":
			request = command({ kind: "retract", keys });
			break;
		case "keep":
			request = command({ kind: "keep", keys });
			break;
		case "retry":
			request = command({ kind: "retry", keys });
			break;
		case "answer":
			if (keys.length !== 1) problems.push("`answer` takes exactly one key");
			request = command({ kind: "answer", key: keys[0] ?? "", value: json("value") });
			break;
		default: {
			const unreachable: never = params.op;
			return unreachable;
		}
	}
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: request };
}

/** A session or command the driver started and has not seen end. */
type Running = { readonly key: string; readonly attempt: number; readonly abort: AbortController };

type Flow = {
	readonly store: Store;
	/** The calling session's own directory: the log, the notes files and its subagents' transcripts live in it. */
	readonly dir: string;
	readonly running: Map<string, Running>;
	/** Wakes the driver: something it should look at has changed. */
	kick: () => void;
	driving: boolean;
};

/** What the spawn hook does for one session the flow is about to start. */
type Prepared = { readonly overlay: string | undefined; readonly model: string | string[] | undefined };

type Runtime = {
	readonly pi: ExtensionAPI;
	readonly flows: Map<string, Flow>;
	/** Sessions about to be spawned, by `spawnId(dir, name)`; the spawn hook takes its entry. */
	readonly spawns: Map<string, Prepared>;
	/** Subagent transcripts whose workspace start this module has handled. */
	readonly started: Set<string>;
};

const spawnId = (dir: string, name: string): string => `${dir}\n${name}`;

async function flowOf(rt: Runtime, parent: AgentSession): Promise<Flow> {
	await parent.sessionManager.ensureOnDisk();
	await parent.sessionManager.flush();
	const sessionFile = parent.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("a flow needs a persisted session");
	const known = rt.flows.get(sessionFile);
	if (known) return known;
	const dir = sessionFile.slice(0, -".jsonl".length);
	const file = path.join(dir, "flow.jsonl");
	const log = readLog(file);
	const store = new Store(log, (action) => appendLog(file, action));
	// A log that already has actions was written by an earlier process; none of its sessions is alive in this one.
	if (log.length > 0) store.recover();
	const flow: Flow = { store, dir, running: new Map(), kick: () => {}, driving: false };
	rt.flows.set(sessionFile, flow);
	return flow;
}

const markOfData = (data: unknown): string => createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 12);

/** The named agents as the `task` tool would resolve them now. */
type Agents = {
	/** Under `definitionKey` and `modelKey`; `null` for an agent the task tool would not run. */
	readonly marks: Record<string, string | null>;
	/** The model setting of each agent that has one of its own: the user's override, else its definition's. */
	readonly models: ReadonlyMap<string, string | string[]>;
};

async function lookUpAgents(parent: AgentSession, names: readonly string[]): Promise<Agents> {
	const marks: Record<string, string | null> = {};
	const models = new Map<string, string | string[]>();
	if (names.length === 0) return { marks, models };
	const { agents } = await discoverAgents(parent.sessionManager.getCwd(), os.homedir(), parent.effectiveExtensionRoots);
	const definitions = [...agents, ...parent.getSessionAgents()];
	const disabled = cfgTaskDisabledAgents.get(parent.settings);
	const overrides = cfgTaskAgentModelOverrides.get(parent.settings);
	for (const name of names) {
		const definition = disabled.includes(name) ? undefined : getAgent(definitions, name);
		const model = definition ? (overrides[name] ?? definition.model) : undefined;
		if (model !== undefined) models.set(name, model);
		marks[definitionKey(name)] = definition
			? markOfData([definition.systemPrompt, definition.tools ?? null, definition.thinkingLevel ?? null])
			: null;
		marks[modelKey(name)] = definition ? markOfData(model ?? null) : null;
	}
	return { marks, models };
}

/** Agent names a `define` call mentions, so their marks are known before the call is judged. */
const agentsIn = (boxes: Readonly<Record<string, Json>>): string[] =>
	Object.values(boxes).flatMap((box) =>
		isObject(box) ? [box.agent, box.model].flatMap((name) => (typeof name === "string" ? [name] : [])) : [],
	);

/** The notes file of an item: one per item, beside the flow's log. */
const boardOf = (flow: Flow, key: string): string => path.join(flow.dir, "flow-boards", `${encodeURIComponent(key)}.md`);

/** Removes the notes files of items that no longer exist, so an item produced again starts with empty notes. */
function pruneBoards(flow: Flow): void {
	const dir = path.join(flow.dir, "flow-boards");
	if (!fs.existsSync(dir)) return;
	for (const file of fs.readdirSync(dir)) {
		const key = decodeURIComponent(file.slice(0, -".md".length));
		if (!(key in flow.store.state.items)) fs.rmSync(path.join(dir, file), { force: true });
	}
}

/**
 * What a session of an isolated box starts from besides the caller's checkout: the changes
 * the last ended session of the same item left without handing them back. `undefined` when
 * there is nothing to carry over.
 */
async function inheritFrom(parent: AgentSession, flow: Flow, earlier: Earlier): Promise<Inheritance | undefined> {
	// A session that yielded has handed its changes to the caller's checkout, unless the user keeps them as patches.
	if (earlier.yielded && cfgTaskIsolationApply.get(parent.settings)) return undefined;
	const callerCwd = parent.sessionManager.getCwd();
	const released = await inheritReleasedPatch(path.join(flow.dir, `${earlier.session}.patch`), callerCwd);
	if (released) return released;
	const ref = AgentRegistry.global().get(earlier.session);
	const file = ref?.sessionFile ?? path.join(flow.dir, `${earlier.session}.jsonl`);
	const cwd = await headerCwd(file);
	if (cwd === undefined) return undefined;
	const open = await inheritSourceWorkspace(
		{ id: earlier.session, file, cwd, running: ref?.status === "running", handedBack: false },
		callerCwd,
	);
	// A session that ran in the caller's own checkout left its changes there.
	return open.kind === "rejected" && open.code === "source-not-isolated" ? undefined : open;
}

const failed = (name: string, reason: string): Outcome => ({ kind: "failed", name, reason });
const clip = (text: string): string => (text.length > 600 ? `${text.slice(0, 600)}…` : text);
/** A failed command's output as the session it reopens reads it: the start and the end, where the failure is named. */
const clipOutput = (text: string): string =>
	text.length > 8000 ? `${text.slice(0, 2000)}\n… ${text.length - 8000} characters left out …\n${text.slice(-6000)}` : text;

function outcomeOfJob(box: AgentBox, job: AsyncJob, session: string): Outcome {
	const where = `history://${session}`;
	const structured = job.structured;
	switch (job.status) {
		case "cancelled":
			return { kind: "cancelled" };
		case "completed": {
			if (structured?.status !== "valid" || !Object.hasOwn(structured, "data")) {
				if (structured?.status === "invalid")
					return failed("schema", `${structured.error ?? "the yielded object does not match the schema"} (${where})`);
				return failed("protocol", `the session ended without yielding an object (${where})`);
			}
			// The yielded payload is JSON a model sent as tool arguments; a round trip gives it the store's type.
			const data = parseJson(JSON.stringify(structured.data ?? null));
			return data.ok ? interpret(box, data.value) : failed("protocol", `${data.problems.join("; ")} (${where})`);
		}
		case "failed":
			if (structured?.status === "invalid")
				return failed("schema", `${structured.error ?? "the yielded object does not match the schema"} (${where})`);
			return failed("session", `${clip(job.errorText ?? "the session failed")} (${where})`);
		case "running":
			return failed("host", `the job of ${where} was reported settled while running`);
		default: {
			const unreachable: never = job.status;
			return unreachable;
		}
	}
}

/** A subagent name no other session has: it is the last segment of the id OMP gives the session, which the spawn hook matches. */
const sessionName = (firing: Firing): string =>
	`Flow${firing.key.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 20)}_s${firing.attempt}_${randomUUID().slice(0, 4)}`;

async function runAgent(
	rt: Runtime,
	parent: AgentSession,
	flow: Flow,
	box: AgentBox,
	firing: Firing,
	signal: AbortSignal,
): Promise<Outcome> {
	if (box.isolated === true && !cfgTaskIsolationEnabled.get(parent.settings)) {
		return failed("spawn", "the box is `isolated`, and this session does not allow isolated subagents (`task.isolation.enabled`)");
	}
	let model: string | string[] | undefined;
	if (box.model !== undefined) {
		model = (await lookUpAgents(parent, [box.model])).models.get(box.model);
		if (model === undefined) return failed("spawn", `agent \`${box.model}\` has no model setting of its own to use`);
	}
	let overlay: string | undefined;
	if (box.isolated === true && firing.earlier) {
		const inherited = await inheritFrom(parent, flow, firing.earlier);
		if (inherited?.kind === "rejected") {
			return failed(
				"workspace",
				`the work of the earlier session ${firing.earlier.session} cannot be carried over (${inherited.code}): ${inherited.detail}`,
			);
		}
		if (inherited?.patch) overlay = inherited.patch;
	}
	const board = boardOf(flow, firing.key);
	fs.mkdirSync(path.dirname(board), { recursive: true });
	if (!fs.existsSync(board)) fs.writeFileSync(board, "");

	const name = sessionName(firing);
	const item: TaskItem = {
		name,
		agent: box.agent,
		task: briefOf(box, firing, { board, inherited: overlay !== undefined }),
		solutionSpace: "as the assignment states",
		outputSchema: yieldSchema(box),
		schemaMode: "strict",
		...(box.isolated === undefined ? {} : { isolated: box.isolated }),
	};
	// The task tool returns once the session's job is registered; the spawn hook runs later, inside that job.
	// So what was prepared for the session stays until the session has ended.
	const prepared = spawnId(flow.dir, name);
	rt.spawns.set(prepared, { overlay, model });
	try {
		return await spawnAndWait(parent, flow, box, firing, item, signal);
	} finally {
		rt.spawns.delete(prepared);
	}
}

async function spawnAndWait(
	parent: AgentSession,
	flow: Flow,
	box: AgentBox,
	firing: Firing,
	item: TaskItem,
	signal: AbortSignal,
): Promise<Outcome> {
	const taskTool = parent.getToolByName("task");
	const manager = parent.asyncJobManager;
	if (!taskTool || !manager) return failed("spawn", "the `task` tool or background jobs are unavailable in this session");
	// The id belongs to no model tool call: the task tool only looks up launches a streamed call of that id prepared.
	// The tool, or a hook around it, may refuse the dispatch by throwing; that is the session not starting.
	const result = await taskTool
		.execute(`flow-${randomUUID()}`, {
			context: "One session of a flow of small assignments. The assignment is complete in itself.",
			tasks: [item],
		})
		.catch((error: unknown) => errorText(error));
	if (typeof result === "string") return failed("spawn", clip(result));
	const progress = progressSchema.safeParse(result.details);
	const id = progress.success ? progress.data.progress[0]?.id : undefined;
	const job = id === undefined ? undefined : manager.getJob(id);
	if (id === undefined || !job) {
		const said = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		return failed("spawn", clip(said || "the task tool started no background job"));
	}
	// The store reads the job row itself; the host's own completion notice to the caller would be a second, unasked report.
	manager.acknowledgeDeliveries([id]);
	const session = job.agentId ?? id;
	flow.store.spawned(firing.key, firing.attempt, session);
	const cancel = (): void => {
		manager.cancel(id);
	};
	if (signal.aborted) cancel();
	else signal.addEventListener("abort", cancel, { once: true });
	await job.promise;
	signal.removeEventListener("abort", cancel);
	return outcomeOfJob(box, job, session);
}

async function runCommand(parent: AgentSession, box: CommandBox, firing: Firing, signal: AbortSignal): Promise<Outcome> {
	let output = "";
	const result = await new Shell().run(
		{ command: fill(box.command, firing.inputs, shellWord), cwd: parent.sessionManager.getCwd(), signal },
		(error, chunk) => {
			if (error === null) output += chunk;
		},
	);
	if (result.cancelled) return { kind: "cancelled" };
	if (result.timedOut) return failed("timeout", clipOutput(output.trim()));
	if (result.exitCode !== 0) return failed("exit", `exit code ${result.exitCode ?? "unknown"}:\n${clipOutput(output.trim())}`);
	return { kind: "done", value: output.trimEnd(), handoff: null };
}

/** A session that answers a raise is also told where the raising item keeps its notes. */
function withBoard(flow: Flow, box: AgentBox, firing: Firing): Firing {
	const source = partsOf(firing.key).source;
	if (!source) return firing;
	const inputs: Record<string, Json> = { ...firing.inputs };
	for (const [input, ref] of Object.entries(box.inputs)) {
		const raise = inputs[input];
		if (ref.source.kind === "raise" && raise !== undefined && isObject(raise))
			inputs[input] = { ...raise, board: boardOf(flow, source.key) };
	}
	return { ...firing, inputs };
}

/**
 * Hands a session the flow is starting what was prepared for it: the changes it inherits,
 * written where the child applies them before its first turn, and the model setting its box names.
 */
async function beforeSubagentSpawn(
	rt: Runtime,
	event: BeforeSubagentSpawnEvent,
	ctx: ExtensionContext,
): Promise<BeforeSubagentSpawnEventResult | undefined> {
	const parentFile = ctx.sessionManager.getSessionFile();
	if (event.invocationKind !== "task" || !event.spawnKey || !parentFile) return;
	const dir = parentFile.slice(0, -".jsonl".length);
	const id = spawnId(dir, event.spawnKey.slice(event.spawnKey.lastIndexOf(".") + 1));
	const prepared = rt.spawns.get(id);
	if (!prepared) return;
	rt.spawns.delete(id);
	try {
		if (prepared.overlay !== undefined) await writeOverlay(path.join(dir, `${event.spawnKey}.jsonl`), prepared.overlay);
	} catch (error) {
		return { block: true, reason: `flow: handing the earlier session's changes to the new one failed: ${errorText(error)}` };
	}
	return prepared.model === undefined ? undefined : { model: prepared.model };
}

/**
 * In every subagent, once per transcript: record where its isolated workspace starts, so a later
 * session can tell what it changed, then apply the changes it inherits. A session whose
 * inherited changes do not apply does not run: its assignment assumes them.
 */
async function beforeAgentStart(rt: Runtime, _event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<undefined> {
	const file = ctx.sessionManager.getSessionFile();
	if (ctx.agent.kind !== "sub" || !file || rt.started.has(file)) return;
	rt.started.add(file);
	const cwd = ctx.sessionManager.getCwd();
	await recordStart(file, cwd, ctx.agent.id).catch((error: unknown) =>
		rt.pi.logger.warn("flow: recording the workspace start failed", { error: errorText(error) }),
	);
	const applied = await applyOverlay(file, cwd).catch((error: unknown) => ({ kind: "failed" as const, message: errorText(error) }));
	if (applied.kind !== "failed") return;
	const reason = `flow: the changes of the earlier session did not apply to this workspace: ${applied.message}`;
	rt.pi.logger.warn(reason);
	callerSession(ctx)?.agent.addBeforeModelCallHook(() => {
		throw new Error(reason);
	});
}

async function fire(rt: Runtime, parent: AgentSession, flow: Flow, firing: Firing): Promise<void> {
	const id = `${firing.key}@${firing.attempt}`;
	const abort = new AbortController();
	flow.running.set(id, { key: firing.key, attempt: firing.attempt, abort });
	let outcome: Outcome;
	try {
		const box = flow.store.state.boxes[firing.box];
		if (!box) outcome = { kind: "cancelled" };
		else if (box.kind === "agent") outcome = await runAgent(rt, parent, flow, box, withBoard(flow, box, firing), abort.signal);
		else outcome = await runCommand(parent, box, firing, abort.signal);
	} catch (error) {
		rt.pi.logger.warn("flow: a firing threw", { key: firing.key, error: errorText(error) });
		outcome = failed("host", errorText(error));
	}
	flow.running.delete(id);
	flow.store.settle(firing.key, firing.attempt, outcome);
	flow.kick();
}

/** Runs the flow until it is no longer running and nothing it started is still alive. */
async function drive(rt: Runtime, parent: AgentSession, flow: Flow): Promise<void> {
	for (;;) {
		const { promise: kicked, resolve } = Promise.withResolvers<void>();
		flow.kick = resolve;
		for (const firing of flow.store.advance()) void fire(rt, parent, flow, firing);
		const orphans = flow.store.orphans([...flow.running.values()]);
		for (const orphan of orphans) flow.running.get(`${orphan.key}@${orphan.attempt}`)?.abort.abort();
		if (flow.store.state.mode.kind !== "running" && flow.running.size === 0) return;
		await kicked;
	}
}

/** Makes sure one job drives the flow; returns the id of a job it started. */
function ensureDriver(rt: Runtime, parent: AgentSession, flow: Flow): string | undefined {
	if (flow.driving) {
		flow.kick();
		return undefined;
	}
	const manager = parent.asyncJobManager;
	if (!manager) throw new Error("background jobs are unavailable in this session");
	flow.driving = true;
	try {
		return manager.register(
			"task",
			"flow",
			async ({ signal }) => {
				const cancelled = (): void => {
					flow.store.submit({ kind: "stop", reason: "the flow's job was cancelled" });
					flow.kick();
				};
				signal.addEventListener("abort", cancelled, { once: true });
				try {
					await drive(rt, parent, flow);
					return flow.store.changes().join("\n");
				} finally {
					signal.removeEventListener("abort", cancelled);
					flow.driving = false;
				}
			},
			{ id: "flow", ownerId: parent.getAgentId() },
		);
	} catch (error) {
		flow.driving = false;
		throw error;
	}
}

async function executeFlow(
	rt: Runtime,
	_toolCallId: string,
	rawParams: unknown,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const reply = (lines: readonly string[], details: Json): AgentToolResult<unknown> => ({
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details,
	});
	const refuse = (refusals: readonly string[], lines: readonly string[] = []): AgentToolResult<unknown> => ({
		content: [{ type: "text" as const, text: [...refusals.map((refusal) => `refused: ${refusal}`), ...lines].join("\n") }],
		details: { accepted: false },
		isError: true,
	});
	try {
		const request = parseRequest(paramsSchema.parse(rawParams));
		if (!request.ok) return refuse(request.problems);
		const parent = callerSession(ctx);
		if (!parent) return refuse(["could not resolve the calling session in the agent registry"]);
		const flow = await flowOf(rt, parent);
		const store = flow.store;
		const mentioned =
			request.value.kind === "command" && request.value.command.kind === "define" ? agentsIn(request.value.command.boxes) : [];
		store.observe((await lookUpAgents(parent, [...new Set([...store.agentNames(), ...mentioned])])).marks);

		switch (request.value.kind) {
			case "status":
				return reply(store.everything(), { accepted: true, mode: store.state.mode.kind });
			case "value": {
				const values: Record<string, Json> = {};
				const missing: string[] = [];
				for (const key of request.value.keys) {
					const value = lookup(store.state, key);
					if (value === undefined) missing.push(`${key}: no value is stored under this key`);
					else values[key] = value;
				}
				if (missing.length > 0) return refuse(missing);
				return reply([JSON.stringify(values, null, 1)], { accepted: true, values });
			}
			case "command": {
				const command = request.value.command;
				if (command.kind === "run" && cfgAsyncEnabled.get(parent.settings) !== true) {
					return refuse(["a flow runs as a background job; this session has `async.enabled` off"]);
				}
				const verdict = store.submit(command);
				if (!verdict.accepted) return refuse(verdict.refusals, verdict.lines);
				pruneBoards(flow);
				const lines = [...verdict.lines];
				if (command.kind === "run") {
					const job = ensureDriver(rt, parent, flow);
					lines.push(
						job === undefined
							? "The flow is already being driven in the background."
							: `The flow runs in the background as job \`${job}\`; its verdict is delivered to you when it stops or comes to rest. End your turn rather than waiting for its sessions.`,
					);
				} else {
					flow.kick();
				}
				return reply(lines, { accepted: true, mode: store.state.mode.kind });
			}
			default: {
				const unreachable: never = request.value;
				return unreachable;
			}
		}
	} catch (error) {
		rt.pi.logger.warn("flow: the call failed", { error: errorText(error) });
		return refuse([errorText(error)]);
	}
}

export default function flow(pi: ExtensionAPI): void {
	const rt: Runtime = { pi, flows: new Map(), spawns: new Map(), started: new Set() };
	pi.on("before_subagent_spawn", beforeSubagentSpawn.bind(null, rt));
	pi.on("before_agent_start", beforeAgentStart.bind(null, rt));
	// `docTopics` serves xd://flow/<topic>; OMP keeps it on the tool object, though ToolDefinition does not declare it.
	const tool: ToolDefinition<typeof paramsSchema> & { docTopics(): Readonly<Record<string, string>> } = {
		name: "flow",
		label: tr("Flow", "流程"),
		description: DESCRIPTION,
		loadMode: "essential",
		parameters: paramsSchema,
		docTopics: flowTopics,
		execute: executeFlow.bind(null, rt),
	};
	pi.registerTool(tool);
}
