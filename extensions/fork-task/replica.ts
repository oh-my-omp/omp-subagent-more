import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Message, Model, SimpleStreamOptions, Tool, ToolChoice } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { parkedFilePath, parsePortableSource, readOptional } from "./replica-file.ts";

/**
 * Plain data only: the agent loop hands providers spread copies of
 * the live AgentTools, whose execute closures and session fields would keep a
 * disposed session reachable for as long as the snapshot lives.
 */
type RequestSnapshot = {
	readonly model: Model;
	readonly context: Pick<Context, "systemPrompt" | "messages" | "tools">;
	readonly options: Pick<
		SimpleStreamOptions,
		"reasoning" | "disableReasoning" | "serviceTier" | "temperature" | "maxTokens" | "cacheRetention" | "sessionId" | "promptCacheKey"
	>;
};

type ObservedRequest = { readonly request: RequestSnapshot; response: number | undefined };

const requests = new WeakMap<AgentSession, ObservedRequest>();
const observed = new WeakSet<AgentSession>();
const liveSessions = new Map<string, AgentSession>();

export type SourceRequest = {
	readonly request: RequestSnapshot;
	readonly response: number | undefined;
	readonly systemPrompt: readonly string[];
	readonly toolNames: readonly string[];
	readonly thinkingLevel: AgentSession["thinkingLevel"];
	readonly ask: AgentTool | undefined;
};

export type PortableSource = Omit<SourceRequest, "ask"> & { readonly cwd: string };

export type ParkedRequest = PortableSource & { readonly response: number };

type SourceRequestResult =
	| { readonly kind: "ready"; readonly source: SourceRequest }
	| { readonly kind: "unavailable"; readonly reason: string };

export type SharedSource =
	| { readonly kind: "ready"; readonly source: PortableSource }
	| { readonly kind: "unavailable"; readonly reason: string };

export async function parkedRequest(file: string): Promise<ParkedRequest | undefined> {
	const text = await readOptional(parkedFilePath(file));
	if (text === undefined) return undefined;
	const source = parsePortableSource(JSON.parse(text));
	const { response } = source;
	return response === undefined ? undefined : { ...source, response };
}

export function observedHere(session: AgentSession): boolean {
	return observed.has(session);
}

function wireTool(tool: Tool): Tool {
	const { name, description, parameters, strict, deferLoading, customFormat, customWireName, native, examples } = tool;
	return {
		name,
		description,
		parameters,
		...(strict !== undefined ? { strict } : {}),
		...(deferLoading !== undefined ? { deferLoading } : {}),
		...(customFormat !== undefined ? { customFormat } : {}),
		...(customWireName !== undefined ? { customWireName } : {}),
		...(native !== undefined ? { native } : {}),
		...(examples !== undefined ? { examples } : {}),
	};
}

export function observeRequests(session: AgentSession, warn: (message: string, error: unknown) => void): void {
	if (observed.has(session)) return;
	observed.add(session);
	const file = session.sessionManager.getSessionFile();
	if (file) {
		liveSessions.set(file, session);
		fs.rmSync(parkedFilePath(file), { force: true });
	}
	session.addDisposer(() => {
		const latest = requests.get(session);
		requests.delete(session);
		const at = session.sessionManager.getSessionFile();
		if (file && liveSessions.get(file) === session) liveSessions.delete(file);
		if (!at || latest?.response === undefined) return;
		const parked: ParkedRequest = {
			request: latest.request,
			response: latest.response,
			systemPrompt: [...session.systemPrompt],
			toolNames: session.agent.state.tools.map((tool) => tool.name),
			thinkingLevel: session.thinkingLevel,
			cwd: session.sessionManager.getCwd(),
		};
		try {
			const target = parkedFilePath(at);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, JSON.stringify(parked));
		} catch (error) {
			warn("fork_task: keeping the parked session's request failed; forking it needs a wake first", error);
		}
	});
	const stream = session.agent.streamFn;
	session.agent.streamFn = (model, context, options) => {
		const latest: ObservedRequest = {
			request: {
				model,
				context: {
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					tools: context.tools?.map(wireTool),
				},
				options: {
					reasoning: options?.reasoning,
					disableReasoning: options?.disableReasoning,
					serviceTier: options?.serviceTier,
					temperature: options?.temperature,
					maxTokens: options?.maxTokens,
					cacheRetention: options?.cacheRetention,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
				},
			},
			response: undefined,
		};
		requests.set(session, latest);
		const events = stream(model, context, options);
		Promise.resolve(events)
			.then((started) => started.result())
			.then(
				(message) => {
					latest.response = message.timestamp;
				},
				() => {},
			);
		return events;
	};
}

export type ForkNotice = { readonly entryId: string; readonly timestamp: number };

type Replay = { readonly kind: "prefix"; readonly response: number | undefined; readonly notice: ForkNotice } | { readonly kind: "own" };

export type Replica = {
	readonly request: RequestSnapshot;
	readonly systemPrompt: readonly string[];
	readonly toolNames: readonly string[];
	readonly ask: AgentTool | undefined;
	readonly sourceModel: string;
	readonly replay: Replay;
	readonly inheritReasoning: boolean;
};

type Capture = Omit<Replica, "replay"> & { readonly response: number | undefined };

export function liveRequest(session: AgentSession): SourceRequestResult {
	const latest = requests.get(session);
	if (!latest) return { kind: "unavailable", reason: "it has not sent a model request in this OMP process since fork capture loaded" };
	return {
		kind: "ready",
		source: {
			request: latest.request,
			response: latest.response,
			systemPrompt: [...session.systemPrompt],
			toolNames: session.agent.state.tools.map((tool) => tool.name),
			thinkingLevel: session.thinkingLevel,
			ask: session.getToolByName("ask"),
		},
	};
}

export async function shareSource(file: string): Promise<SharedSource | undefined> {
	const session = liveSessions.get(file);
	if (!session) return undefined;
	const live = liveRequest(session);
	if (live.kind === "unavailable") return live;
	await session.sessionManager.ensureOnDisk();
	await session.sessionManager.flush();
	const { ask: _live, ...source } = live.source;
	return { kind: "ready", source: { ...source, cwd: session.sessionManager.getCwd() } };
}

export function captureReplica(
	source: SourceRequest,
	options: { readonly inheritReasoning: boolean; readonly caller: AgentSession },
): Capture {
	const { request, toolNames, thinkingLevel: level } = source;
	return {
		request,
		response: source.response,
		systemPrompt: source.systemPrompt,
		toolNames,
		ask: toolNames.includes("ask") ? (options.caller.getToolByName("ask") ?? source.ask) : undefined,
		sourceModel: `${request.model.provider}/${request.model.id}${level ? `:${level}` : ""}`,
		inheritReasoning: options.inheritReasoning,
	};
}

type PrefixReplay = Extract<Replay, { kind: "prefix" }>;

function childStart(messages: readonly Message[], replay: PrefixReplay): number {
	// It cannot stop at the
	// notice, because a duplicate notice before it makes the notice ambiguous.
	const noticeTimestamp = replay.notice.timestamp;
	const { response } = replay;
	let notice = -1;
	let anchor = -1;
	let anchors = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		const isNotice = message.role === "developer" && message.timestamp === noticeTimestamp;
		if (notice === -1) {
			if (isNotice) notice = index;
			continue;
		}
		if (isNotice) throw new Error("fork_task: the fork notice is ambiguous in the child context");
		if (message.role !== "assistant" || message.timestamp !== response) continue;
		anchor = index;
		anchors++;
	}
	if (notice === -1) throw new Error("fork_task: the fork notice is missing from the child context");
	if (response === undefined) return notice;
	return anchors === 1 ? anchor : notice;
}

function replaysPrefix(session: AgentSession, notice: ForkNotice): boolean {
	const branch = session.sessionManager.getBranchView();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction") return false;
		if (entry.id === notice.entryId) return true;
	}
	return false;
}

function replicatedMessages(session: AgentSession, replay: Replay, source: readonly Message[], current: Message[]): Message[] {
	switch (replay.kind) {
		case "own":
			return current;
		case "prefix": {
			if (!replaysPrefix(session, replay.notice)) return current;
			const start = childStart(current, replay);
			const merged: Message[] = new Array(source.length + current.length - start);
			for (let index = 0; index < source.length; index++) merged[index] = source[index]!;
			for (let index = source.length, tail = start; tail < current.length; index++, tail++) merged[index] = current[tail]!;
			return merged;
		}
		default: {
			const unreachable: never = replay;
			return unreachable;
		}
	}
}

type ModelKey = Pick<Model, "provider" | "id">;

export function sameModel(a: ModelKey, b: ModelKey): boolean {
	return a.provider === b.provider && a.id === b.id;
}

const BRIDGE_TOOL = "eval";

function forcedToolName(choice: ToolChoice | undefined): string | undefined {
	if (choice === undefined || typeof choice === "string") return undefined;
	switch (choice.type) {
		case "tool":
			return choice.name;
		case "function":
			return "name" in choice ? choice.name : choice.function.name;
		case "computer":
			return undefined;
		default: {
			const unreachable: never = choice;
			return unreachable;
		}
	}
}

function forceTool(choice: Exclude<ToolChoice, string>, name: string): ToolChoice {
	switch (choice.type) {
		case "tool":
			return { type: "tool", name };
		case "function":
			return "name" in choice ? { type: "function", name } : { type: "function", function: { name } };
		case "computer":
			return choice;
		default: {
			const unreachable: never = choice;
			return unreachable;
		}
	}
}

type WireTools = { readonly tools: Tool[] | undefined; readonly toolChoice: ToolChoice | undefined };

function wireTools(source: Tool[] | undefined, current: Context, onSourceModel: boolean, choice: ToolChoice | undefined): WireTools {
	const names = new Set(source?.map((tool) => tool.name));
	const own = current.tools?.filter((tool) => !names.has(tool.name)) ?? [];
	if (own.length === 0) return { tools: source, toolChoice: choice };
	if (!onSourceModel || !names.has(BRIDGE_TOOL)) return { tools: [...(source ?? []), ...own], toolChoice: choice };
	const forced = forcedToolName(choice);
	const forcesOwn = choice !== undefined && typeof choice !== "string" && own.some((tool) => tool.name === forced);
	return { tools: source, toolChoice: forcesOwn ? forceTool(choice, BRIDGE_TOOL) : choice };
}

function replicateContext(session: AgentSession, replica: Replica, current: Context, tools: Tool[] | undefined): Context {
	const source = replica.request.context;
	return {
		...current,
		systemPrompt: source.systemPrompt,
		tools,
		messages: replicatedMessages(session, replica.replay, source.messages, current.messages),
	};
}

export type OwnYield = { readonly tool: AgentTool; readonly sourceModel: ModelKey };

export function applyReplica(session: AgentSession, replica: Replica): OwnYield | undefined {
	const own = new Map(session.agent.state.tools.map((tool) => [tool.name, tool]));
	const names = new Set(replica.toolNames);
	const tools = replica.toolNames.map((name) => {
		const local = own.get(name) ?? session.getToolByName(name);
		if (local) return local;
		// Never fabricate a same-schema tool that always returns an error.
		if (name === "ask" && replica.ask) return replica.ask;
		throw new Error(`fork_task: cannot clone source tool \`${name}\` into this child`);
	});
	// Only completion extends the source's capability surface. Do not expose
	// other tools admitted by the unrestricted internal agent definition.
	const yieldTool = own.get("yield") ?? session.getToolByName("yield");
	const ownYield = yieldTool && !names.has("yield") ? yieldTool : undefined;
	if (ownYield) tools.push(ownYield);
	const systemPrompt = [...replica.systemPrompt];
	const detach = session.agent.addBeforeModelCallHook(() => {
		session.agent.setSystemPrompt(systemPrompt);
		session.agent.setTools(tools);
	});
	session.addDisposer(detach);

	const stream = session.agent.streamFn;
	const source = replica.request;
	const wrap: StreamFn = (model, context, options) => {
		const onSourceModel = sameModel(model, source.model);
		const wire = wireTools(source.context.tools, context, onSourceModel, options?.toolChoice);
		const replicated = replicateContext(session, replica, context, wire.tools);
		if (!onSourceModel) {
			return stream(model, replicated, { ...options, parentSessionId: source.options.sessionId });
		}
		return stream(model, replicated, {
			...options,
			toolChoice: wire.toolChoice,
			...(replica.inheritReasoning ? { reasoning: source.options.reasoning, disableReasoning: source.options.disableReasoning } : {}),
			serviceTier: source.options.serviceTier,
			temperature: source.options.temperature,
			maxTokens: source.options.maxTokens,
			cacheRetention: source.options.cacheRetention,
			promptCacheKey: source.options.promptCacheKey ?? source.options.sessionId,
			parentSessionId: source.options.sessionId,
		});
	};
	session.agent.streamFn = wrap;
	return ownYield && names.has(BRIDGE_TOOL)
		? { tool: ownYield, sourceModel: { provider: source.model.provider, id: source.model.id } }
		: undefined;
}
