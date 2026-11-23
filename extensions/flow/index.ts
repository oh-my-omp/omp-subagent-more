import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type {
	AgentSession,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeSubagentSpawnEvent,
	BeforeSubagentSpawnEventResult,
	ExtensionAPI,
	ExtensionContext,
	TaskItem,
	ToolDefinition,
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
import { tr } from "../../omomp-shared/i18n.ts";
import { callerSession } from "../fork-task/caller-session.ts";
import { errorText } from "../fork-task/errors.ts";
import type { ForkItem } from "../fork-task/schema.ts";
import { headerCwd, type Inheritance, inheritSourceWorkspace, writeOverlay, writePrepare } from "../fork-task/workspace.ts";
import { type AgentBox, type CommandBox, fill, isObject, type Json, parseJson, type Result, shellWord } from "./defs.ts";
import { DESCRIPTION, flowTopics, registerFlowTopics } from "./docs.ts";
import { inheritKeptBranch, inheritReleasedPatch, keptTaskBranch } from "./inherit.ts";
import { appendLog, readLog } from "./journal.ts";
import { type Firing, lookup } from "./plan.ts";
import { briefOf, commandOutcome, interpret, splittable, yieldSchema } from "./session.ts";
import { markSplittable, registerSplitTool, type SplitAnswer, type SplitAsk, serveSplits } from "./split.ts";
import { definitionKey, type Earlier, modelKey, type Outcome, partsOf } from "./state.ts";
import { type Command, Store } from "./store.ts";

const OPS = ["define", "supply", "run", "stop", "status", "value", "retract", "keep", "retry", "answer", "agree", "disagree"] as const;
type Op = (typeof OPS)[number];

const paramsSchema = z.object({
	op: z
		.enum(OPS)
		.describe(
			"What to do. `define`: add, replace or drop boxes. `supply`: give an outside input its value. `run`: start the flow or resume a stopped one. `stop`: stop a running flow. `status`: report the whole state. `value`: read stored values. `retract`: remove items or inputs and what was computed from them. `keep`: let stale items stand. `retry`: let failed items fire again unchanged. `answer`: answer an item's raise. `agree`: approve the split a running session asks for; it yields and each part runs as an isolated fork of it. `disagree`: refuse that split; the session continues with your reason.",
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
			"Keys as verdicts print them: an item (`scout`, `work#1`, `answer<work#1@1>`), and for `retract` and `value` also `input.<name>`; `value` takes a box name too. Required by `value`, `retract`, `keep` and `retry`; `answer`, `agree` and `disagree` take exactly one, the item whose session raised or asks to split.",
		),
	reason: z
		.string()
		.optional()
		.describe(
			"With `stop`, optional: why the flow is stopped, recorded with the stop. With `disagree`, required: why the split is refused; the session that asked continues with it.",
		),
});
type Params = z.infer<typeof paramsSchema>;

const progressSchema = z.object({ progress: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();

type Request =
	| { readonly kind: "command"; readonly command: Command }
	| { readonly kind: "status" }
	| { readonly kind: "value"; readonly keys: readonly string[] }
	| { readonly kind: "decide"; readonly key: string; readonly verdict: Verdict };

type Verdict = { readonly kind: "agree" } | { readonly kind: "disagree"; readonly reason: string };

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
	agree: { keys: "required" },
	disagree: { keys: "required", reason: "required" },
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
		case "agree":
			if (keys.length !== 1) problems.push("`agree` takes exactly one key");
			request = { kind: "decide", key: keys[0] ?? "", verdict: { kind: "agree" } };
			break;
		case "disagree": {
			if (keys.length !== 1) problems.push("`disagree` takes exactly one key");
			const reason = params.reason?.trim() ?? "";
			if (params.reason !== undefined && reason === "") problems.push("`disagree` needs a non-empty `reason`");
			request = { kind: "decide", key: keys[0] ?? "", verdict: { kind: "disagree", reason } };
			break;
		}
		default: {
			const unreachable: never = params.op;
			return unreachable;
		}
	}
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: request };
}

type Running = { readonly key: string; readonly attempt: number; readonly abort: AbortController };

type SplitState =
	| { readonly kind: "none" }
	| {
			readonly kind: "asked";
			readonly parts: readonly Json[];
			readonly answer: (answer: SplitAnswer) => void;
	  }
	| { readonly kind: "approved"; readonly parts: readonly Json[] };

type Live = {
	readonly key: string;
	readonly attempt: number;
	readonly box: AgentBox;
	readonly depth: number;
	split: SplitState;
};

type Flow = {
	readonly store: Store;
	readonly dir: string;
	readonly running: Map<string, Running>;
	readonly live: Map<string, Live>;
	kick: () => void;
	driving: boolean;
};

type Prepared = {
	readonly overlay: string | undefined;
	readonly model: string | string[] | undefined;
	readonly prepare: string | undefined;
	readonly splittable: boolean;
};

type Runtime = {
	readonly pi: ExtensionAPI;
	readonly flows: Map<string, Flow>;
	readonly spawns: Map<string, Prepared>;
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
	if (log.length > 0) store.recover();
	const flow: Flow = { store, dir, running: new Map(), live: new Map(), kick: () => {}, driving: false };
	rt.flows.set(sessionFile, flow);
	return flow;
}

const markOfData = (data: unknown): string => createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 12);

type Agents = {
	readonly marks: Record<string, string | null>;
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

const agentsIn = (boxes: Readonly<Record<string, Json>>): string[] =>
	Object.values(boxes).flatMap((box) =>
		isObject(box) ? [box.agent, box.model].flatMap((name) => (typeof name === "string" ? [name] : [])) : [],
	);

const boardOf = (flow: Flow, key: string): string => path.join(flow.dir, "flow-boards", `${encodeURIComponent(key)}.md`);

function pruneBoards(flow: Flow): void {
	const dir = path.join(flow.dir, "flow-boards");
	if (!fs.existsSync(dir)) return;
	for (const file of fs.readdirSync(dir)) {
		const key = decodeURIComponent(file.slice(0, -".md".length));
		if (!(key in flow.store.state.items)) fs.rmSync(path.join(dir, file), { force: true });
	}
}

async function inheritFrom(parent: AgentSession, flow: Flow, earlier: Earlier): Promise<Inheritance | undefined> {
	if (earlier.yielded && cfgTaskIsolationApply.get(parent.settings)) return undefined;
	const callerCwd = parent.sessionManager.getCwd();
	const kept = await keptTaskBranch(earlier.session, callerCwd);
	if (kept !== undefined) return inheritKeptBranch(kept, callerCwd);
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
	return open.kind === "rejected" && open.code === "source-not-isolated" ? undefined : open;
}

const failed = (name: string, reason: string): Outcome => ({ kind: "failed", name, reason });
const clip = (text: string): string => (text.length > 600 ? `${text.slice(0, 600)}…` : text);

function outcomeOfJob(box: AgentBox, depth: number, job: AsyncJob, session: string, approved: readonly Json[] | undefined): Outcome {
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
			const data = parseJson(JSON.stringify(structured.data ?? null));
			return data.ok ? interpret(box, depth, data.value, approved) : failed("protocol", `${data.problems.join("; ")} (${where})`);
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
	const forkOf = firing.continuation?.kind === "part" ? firing.earlier?.session : undefined;
	if (firing.continuation?.kind === "part" && forkOf === undefined) {
		return failed("spawn", "the part has no splitting session to fork");
	}
	let model: string | string[] | undefined;
	if (box.model !== undefined && forkOf === undefined) {
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
	const task = briefOf(box, firing, { board, inherited: overlay !== undefined });
	const outputSchema = yieldSchema(box, firing.depth);
	let launch: Launch;
	if (forkOf === undefined) {
		const item: TaskItem = {
			name,
			agent: box.agent,
			task,
			solutionSpace: "as the assignment states",
			outputSchema,
			schemaMode: "strict",
			...(box.isolated === undefined ? {} : { isolated: box.isolated }),
		};
		launch = { tool: "task", item };
	} else {
		const item: ForkItem = {
			name,
			from: forkOf,
			agent: undefined,
			task,
			workspace: "isolated_from_caller",
			shake: false,
			effort: undefined,
			outputSchema,
			schemaMode: "strict",
		};
		launch = { tool: "fork_task", item };
	}
	const prepared = spawnId(flow.dir, name);
	const prepare = box.prepare === undefined ? undefined : fill(box.prepare, firing.inputs, shellWord);
	rt.spawns.set(prepared, { overlay, model, prepare, splittable: splittable(box, firing.depth) });
	try {
		return await spawnAndWait(parent, flow, box, firing, launch, signal);
	} finally {
		rt.spawns.delete(prepared);
	}
}

type Launch = { readonly tool: "task"; readonly item: TaskItem } | { readonly tool: "fork_task"; readonly item: ForkItem };

async function spawnAndWait(
	parent: AgentSession,
	flow: Flow,
	box: AgentBox,
	firing: Firing,
	launch: Launch,
	signal: AbortSignal,
): Promise<Outcome> {
	const tool = parent.getToolByName(launch.tool);
	const manager = parent.asyncJobManager;
	if (!tool || !manager) return failed("spawn", `the \`${launch.tool}\` tool or background jobs are unavailable in this session`);
	const result = await tool
		.execute(`flow-${randomUUID()}`, {
			context: "One session of a flow of small assignments. The assignment is complete in itself.",
			tasks: [launch.item],
		})
		.catch((error: unknown) => errorText(error));
	if (typeof result === "string") return failed("spawn", clip(result));
	const progress = progressSchema.safeParse(result.details);
	const id = progress.success ? progress.data.progress[0]?.id : undefined;
	const job = id === undefined ? undefined : manager.getJob(id);
	if (id === undefined || !job) {
		const said = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		return failed("spawn", clip(said || `the \`${launch.tool}\` tool started no background job`));
	}
	manager.acknowledgeDeliveries([id]);
	const session = job.agentId ?? id;
	flow.store.spawned(firing.key, firing.attempt, session);
	const live: Live = { key: firing.key, attempt: firing.attempt, box, depth: firing.depth, split: { kind: "none" } };
	flow.live.set(session, live);
	const cancel = (): void => {
		manager.cancel(id);
	};
	if (signal.aborted) cancel();
	else signal.addEventListener("abort", cancel, { once: true });
	await job.promise;
	signal.removeEventListener("abort", cancel);
	flow.live.delete(session);
	const outcome = outcomeOfJob(box, firing.depth, job, session, live.split.kind === "approved" ? live.split.parts : undefined);
	if (outcome.kind !== "done" && outcome.kind !== "raise" && outcome.kind !== "split") return outcome;
	if (box.isolated !== false && cfgTaskIsolationApply.get(parent.settings)) {
		const kept = await keptTaskBranch(session, parent.sessionManager.getCwd());
		if (kept !== undefined) {
			return failed(
				"workspace",
				`the session yielded, but OMP kept its changes on branch \`${kept}\` instead of merging them into your checkout, which may be left half-updated (\`git status\`); the item's next session starts from that branch (history://${session})`,
			);
		}
	}
	const refusal = handBackFailure(job.resultText ?? "");
	if (refusal === undefined) return outcome;
	return failed(
		"workspace",
		`the session yielded, but OMP did not get its changes into your checkout, which may be left half-updated (\`git status\`). OMP says: ${clip(refusal)} (history://${session})`,
	);
}

function handBackFailure(resultText: string): string | undefined {
	const open = resultText.lastIndexOf("<merge-summary>");
	const close = resultText.indexOf("</merge-summary>", open);
	if (open < 0 || close < 0) return undefined;
	const summary = resultText.slice(open + "<merge-summary>".length, close);
	const plain = summary.replaceAll("&lt;", "<");
	if (!plain.includes("<system-notification>")) return undefined;
	return plain.replace(/<\/?system-notification>/g, "").trim();
}

async function runCommand(parent: AgentSession, box: CommandBox, firing: Firing, signal: AbortSignal): Promise<Outcome> {
	let output = "";
	const result = await new Shell().run(
		{ command: fill(box.command, firing.inputs, shellWord), cwd: parent.sessionManager.getCwd(), signal },
		(error, chunk) => {
			if (error === null) output += chunk;
		},
	);
	return commandOutcome(box, {
		exitCode: result.exitCode ?? undefined,
		timedOut: result.timedOut,
		cancelled: result.cancelled,
		output,
	});
}

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
	const childFile = path.join(dir, `${event.spawnKey}.jsonl`);
	try {
		if (prepared.overlay !== undefined) await writeOverlay(childFile, prepared.overlay);
		if (prepared.prepare !== undefined) await writePrepare(childFile, prepared.prepare);
		if (prepared.splittable) await markSplittable(childFile);
	} catch (error) {
		return { block: true, reason: `flow: handing the new session what was prepared for it failed: ${errorText(error)}` };
	}
	return prepared.model === undefined ? undefined : { model: prepared.model };
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

function claimSplit(rt: Runtime, flow: Flow, ask: SplitAsk, answer: (answer: SplitAnswer) => void): boolean {
	const live = flow.live.get(ask.session);
	if (!live) return false;
	const refuse = (reason: string): true => {
		answer({ kind: "refused", reason });
		return true;
	};
	if (!splittable(live.box, live.depth)) return refuse("this session's box allows it no further split");
	if (live.split.kind === "asked") return refuse("an earlier split request of this session is still waiting for the author");
	if (live.split.kind === "approved")
		return refuse('the author already agreed to a split of this session; yield `{"status": "split", …}` now');
	const parts: Json[] = [];
	for (const [index, text] of ask.parts.entries()) {
		const parsed = parseJson(text);
		if (!parsed.ok) return refuse(`piece ${index + 1} is not JSON text: ${parsed.problems.join("; ")}`);
		parts.push(parsed.value);
	}
	if (parts.length < 2) return refuse("a split needs at least two pieces");
	live.split = { kind: "asked", parts, answer };
	answer({ kind: "waiting" });
	rt.pi.sendMessage(
		{ customType: "flow-split", content: splitNotice(live, ask.session, parts, ask.details), display: true },
		{ deliverAs: "aside", triggerTurn: true },
	);
	return true;
}

function splitNotice(live: Live, session: string, parts: readonly Json[], details: string): string {
	return [
		`Flow item \`${live.key}\` (session \`${session}\`, history://${session}) asks to split its assignment into ${parts.length} parts. The session is blocked until you answer.`,
		"",
		"Details from the session:",
		details,
		"",
		"Parts, each taking the place of the item's fanned input:",
		...parts.map((part, index) => `${index + 1}. ${JSON.stringify(part)}`),
		"",
		`Answer with the \`flow\` tool: op \`agree\` with keys ["${live.key}"], or op \`disagree\` with keys ["${live.key}"] and a \`reason\`. On agree the session yields, and each part runs as an isolated fork of it; on disagree the session continues with your reason.`,
	].join("\n");
}

function waitingSplits(flow: Flow): string[] {
	return [...flow.live.entries()].flatMap(([session, live]) =>
		live.split.kind === "asked"
			? [`split asked: ${live.key} (session ${session}) into ${live.split.parts.length} parts, waiting for \`agree\` or \`disagree\``]
			: [],
	);
}

function decide(flow: Flow, key: string, verdict: Verdict): Result<string> {
	const live = [...flow.live.values()].find((candidate) => candidate.key === key);
	if (live?.split.kind !== "asked") return { ok: false, problems: [`no split request of \`${key}\` is waiting for an answer`] };
	const { parts, answer } = live.split;
	switch (verdict.kind) {
		case "agree":
			live.split = { kind: "approved", parts };
			answer({ kind: "agreed" });
			return {
				ok: true,
				value: `agreed: ${key} yields its split, and each of its ${parts.length} parts runs as an isolated fork of its session`,
			};
		case "disagree":
			live.split = { kind: "none" };
			answer({ kind: "disagreed", reason: verdict.reason });
			return { ok: true, value: `disagreed: ${key} continues its session with your reason` };
		default: {
			const unreachable: never = verdict;
			return unreachable;
		}
	}
}

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
				const splits = serveSplits((ask, answer) => claimSplit(rt, flow, ask, answer));
				try {
					await drive(rt, parent, flow);
					return flow.store.changes().join("\n");
				} finally {
					splits.close();
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
				return reply([...store.everything(), ...waitingSplits(flow)], { accepted: true, mode: store.state.mode.kind });
			case "decide": {
				const decided = decide(flow, request.value.key, request.value.verdict);
				return decided.ok ? reply([decided.value], { accepted: true }) : refuse(decided.problems);
			}
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
	const rt: Runtime = { pi, flows: new Map(), spawns: new Map() };
	pi.on("before_subagent_spawn", beforeSubagentSpawn.bind(null, rt));
	registerSplitTool(pi);
	registerFlowTopics();
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
