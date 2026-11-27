import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Message, Model, SimpleStreamOptions, Tool, ToolChoice } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { readOptional } from "../_shared/session-files.ts";
import { parkedFilePath, parsePortableSource } from "./replica-file.ts";

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

export type ContextFragment = { readonly path: string; readonly text: string };

const requests = new WeakMap<AgentSession, ObservedRequest>();
const observed = new WeakSet<AgentSession>();
const liveSessions = new Map<string, AgentSession>();
const replicatedContext = new WeakMap<AgentSession, readonly ContextFragment[]>();

function promptContextFiles(session: AgentSession, prompt: readonly string[] | undefined): ContextFragment[] {
	const inherited = replicatedContext.get(session);
	if (inherited) return [...inherited];
	const built = session.systemPromptSources;
	if (!built || !prompt) return [];
	return built.sources.flatMap((source) => {
		const block = built.blocks[source.block];
		if (source.kind !== "instruction-files" || block === undefined) return [];
		const text = block.slice(source.start, source.end);
		return prompt.some((sent) => sent.includes(text)) ? [{ path: source.label, text }] : [];
	});
}

export type SourceRequest = {
	readonly request: RequestSnapshot;
	readonly response: number | undefined;
	readonly systemPrompt: readonly string[];
	readonly contextFiles: readonly ContextFragment[];
	readonly thinkingLevel: AgentSession["thinkingLevel"];
};

export type PortableSource = SourceRequest & { readonly cwd: string };

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
			contextFiles: promptContextFiles(session, latest.request.context.systemPrompt),
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
	readonly contextFiles: readonly ContextFragment[];
	readonly cwd: string;
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
			contextFiles: promptContextFiles(session, latest.request.context.systemPrompt),
			thinkingLevel: session.thinkingLevel,
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
	return { kind: "ready", source: { ...live.source, cwd: session.sessionManager.getCwd() } };
}

export function captureReplica(source: PortableSource, options: { readonly inheritReasoning: boolean }): Capture {
	const { request, thinkingLevel: level } = source;
	return {
		request,
		response: source.response,
		systemPrompt: source.systemPrompt,
		contextFiles: source.contextFiles,
		cwd: source.cwd,
		sourceModel: `${request.model.provider}/${request.model.id}${level ? `:${level}` : ""}`,
		inheritReasoning: options.inheritReasoning,
	};
}

type PrefixReplay = Extract<Replay, { kind: "prefix" }>;

function childStart(messages: readonly Message[], replay: PrefixReplay): number {
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

function sameModel(a: ModelKey, b: ModelKey): boolean {
	return a.provider === b.provider && a.id === b.id;
}

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

type WireTools = { readonly tools: Tool[] | undefined; readonly toolChoice: ToolChoice | undefined };

// Never force a tool the source declaration lacks: the executor pins its final reminder to the child's own `yield`.
function wireTools(source: Tool[] | undefined, choice: ToolChoice | undefined): WireTools {
	const forced = forcedToolName(choice);
	const declared = forced === undefined || (source?.some((tool) => tool.name === forced) ?? false);
	return { tools: source, toolChoice: declared ? choice : undefined };
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

export type OwnYield = { readonly tool: AgentTool; readonly declared: boolean };

export function applyReplica(session: AgentSession, replica: Replica): OwnYield | undefined {
	const yieldTool = session.agent.state.tools.find((tool) => tool.name === "yield");
	const systemPrompt = [...replica.systemPrompt];
	replicatedContext.set(session, replica.contextFiles);
	const detach = session.agent.addBeforeModelCallHook(() => {
		session.agent.setSystemPrompt(systemPrompt);
	});
	session.addDisposer(detach);

	const stream = session.agent.streamFn;
	const source = replica.request;
	const wrap: StreamFn = (model, context, options) => {
		const wire = wireTools(source.context.tools, options?.toolChoice);
		const replicated = replicateContext(session, replica, context, wire.tools);
		if (!sameModel(model, source.model)) {
			return stream(model, replicated, { ...options, toolChoice: wire.toolChoice, parentSessionId: source.options.sessionId });
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
	return yieldTool && { tool: yieldTool, declared: source.context.tools?.some((tool) => tool.name === "yield") ?? false };
}
