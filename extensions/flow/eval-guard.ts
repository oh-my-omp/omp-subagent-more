import * as os from "node:os";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { resolveReadPathAsync } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";
import { astMatch } from "@oh-my-pi/pi-natives";
import { callerSession } from "../fork-task/caller-session.ts";
import { errorText } from "../fork-task/errors.ts";

export type Refused = "agent" | "workpool" | "judge" | "judge_batch" | "completion" | "tool.flow";

const cellSchema = z.object({ language: z.enum(["py", "js"]), code: z.string() }).passthrough();

type Language = z.infer<typeof cellSchema>["language"];

const REFUSED: Readonly<Record<Language, readonly Refused[]>> = {
	js: ["agent", "workpool"],
	py: ["agent", "workpool", "judge", "judge_batch", "completion", "tool.flow"],
};

type Topic = "help://flow/eval" | "help://eval/judge";

const TOPICS: readonly Topic[] = ["help://flow/eval", "help://eval/judge"];

const TOPIC: Readonly<Record<Refused, Topic>> = {
	agent: "help://flow/eval",
	workpool: "help://flow/eval",
	"tool.flow": "help://flow/eval",
	judge: "help://eval/judge",
	judge_batch: "help://eval/judge",
	completion: "help://eval/judge",
};

export type Script = { readonly path: string; readonly code: string };

export type LoadTarget = { readonly kind: "cell"; readonly file: string } | { readonly kind: "line"; readonly file: string };

export type Load = (target: LoadTarget) => Promise<Script | null>;

const GRAMMAR: Readonly<Record<Language, string>> = { py: "python", js: "typescript" };

const STANDALONE_LOAD = /^%load(?:[ \t]+([^\r\n]*))?$/;

const ASSIGN_LINE = /^[ \t]*[A-Za-z_][A-Za-z_0-9.[\], ]*?\s*=\s*(.+)$/;

const INLINE_LOAD = /^%load(?:\s+([\s\S]*))?$/;

const CODE_LINE_MAGIC = /^%(?:time|timeit)(?:\s+([\s\S]*))?$/;

const BODY_CELL_MAGICS: Readonly<Record<string, true>> = { capture: true, timeit: true };

type Quote = { readonly mark: string; readonly triple: boolean; readonly raw: boolean };

function scanQuotes(line: string, open: Quote | null): Quote | null {
	let quote = open;
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (quote !== null) {
			if (!quote.raw && ch === "\\") {
				i += 2;
			} else if (quote.triple ? line.startsWith(quote.mark.repeat(3), i) : ch === quote.mark) {
				i += quote.triple ? 3 : 1;
				quote = null;
			} else {
				i += 1;
			}
			continue;
		}
		if (ch === "#") return null;
		const start = /^([rRbBfFuU]{0,3})('''|"""|'|")/.exec(line.slice(i));
		const opener = start?.[2];
		if (start && opener) {
			quote = { mark: opener.charAt(0), triple: opener.length === 3, raw: (start[1] ?? "").toLowerCase().includes("r") };
			i += start[0].length;
			continue;
		}
		i += 1;
	}
	return quote;
}

type PythonCell = { readonly code: string; readonly loads: readonly string[] };

export function normalizePython(source: string): PythonCell {
	const lines = source.split("\n");
	const kept = [...lines];
	const loads: string[] = [];
	let quote: Quote | null = null;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (quote === null) {
			const stripped = line.trimStart();
			const command = stripped.startsWith("%") || stripped.startsWith("!");
			const rhs = command ? "" : (ASSIGN_LINE.exec(line)?.[1]?.trim() ?? "");
			if (command || rhs.startsWith("%") || rhs.startsWith("!")) {
				if (stripped.startsWith("%%")) {
					if (!BODY_CELL_MAGICS[/^%%(\w+)/.exec(stripped)?.[1] ?? ""]) {
						kept.fill("", i);
						break;
					}
					kept[i] = "";
					i += 1;
					continue;
				}
				let end = i + 1;
				if (command) while (end < lines.length && lines[end - 1]?.endsWith("\\")) end += 1;
				const magic = (command ? lines.slice(i, end).join("\n") : rhs).trimStart().replace(/\\\n/g, " ");
				const load = INLINE_LOAD.exec(magic);
				if (load) loads.push(load[1] ?? "");
				kept.fill("", i, end);
				const code = CODE_LINE_MAGIC.exec(magic)?.[1];
				if (code !== undefined) kept[i] = `${/^[ \t]*/.exec(line)?.[0] ?? ""}${code.replace(/\n/g, " ")}`;
				i = end;
				continue;
			}
		}
		quote = scanQuotes(line, quote);
		i += 1;
	}
	return { code: kept.join("\n"), loads };
}

const patterns = (language: Language, name: Refused): string[] =>
	language === "js" ? [`${name}($$$ARGS)`, `globalThis.${name}($$$ARGS)`] : [`${name}($$$ARGS)`];

async function calledIn(language: Language, code: string): Promise<Refused[]> {
	const found = await Promise.all(
		REFUSED[language].map(async (name) => {
			const result = await astMatch({ source: code, lang: GRAMMAR[language], patterns: patterns(language, name), limit: 1 });
			return result.totalMatches > 0 ? [name] : [];
		}),
	);
	return found.flat();
}

const singleArg = (raw: string): string | null => {
	try {
		const args = parseCommandArgs(raw, { strict: true });
		return args.length === 1 && args[0] ? args[0] : null;
	} catch {
		return null;
	}
};

async function scan(language: Language, code: string, load: Load, seen: Set<string>): Promise<Set<Refused>> {
	const standalone = STANDALONE_LOAD.exec(code.trim());
	if (standalone) {
		const file = singleArg(standalone[1] ?? "");
		const script = file === null ? null : await load({ kind: "cell", file });
		return script === null ? new Set() : included(language, script, load, seen);
	}
	if (language === "js") return new Set(await calledIn("js", code));
	const cell = normalizePython(code);
	const found = new Set(await calledIn("py", cell.code));
	for (const raw of cell.loads) {
		const file = singleArg(raw);
		const script = file === null ? null : await load({ kind: "line", file });
		if (script !== null) for (const name of await included("py", script, load, seen)) found.add(name);
	}
	return found;
}

async function included(language: Language, script: Script, load: Load, seen: Set<string>): Promise<Set<Refused>> {
	if (seen.has(script.path)) return new Set();
	seen.add(script.path);
	if (language === "js") return new Set(await calledIn("js", script.code));
	return scan("py", script.code, load, seen);
}

export async function refusedCalls(language: Language, code: string, load: Load): Promise<Refused[]> {
	const found = await scan(language, code, load, new Set());
	return REFUSED[language].filter((name) => found.has(name));
}

const listed = (names: readonly Refused[]): string => {
	const shown = names.map((name) => `\`${name}()\``);
	return shown.length < 3 ? shown.join(" and ") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
};

export function refusal(language: Language, names: readonly Refused[]): string {
	switch (language) {
		case "js":
			return [
				`This eval cell was not run: it calls ${listed(names)} from the eval prelude. Subagents started from an eval cell are cancelled when the cell is interrupted; start them through the flow tool instead:`,
				"help://flow/eval",
			].join("\n");
		case "py":
			return [
				`This Python eval cell was not run: it calls ${listed(names)}. Python eval cells only compute and do not call models or the flow; make these calls from a JavaScript eval cell instead:`,
				...TOPICS.filter((topic) => names.some((name) => TOPIC[name] === topic)),
			].join("\n");
		default: {
			const unreachable: never = language;
			return unreachable;
		}
	}
}

export async function inspectEval(toolName: string, input: unknown, load: Load): Promise<string | null> {
	if (toolName !== "eval") return null;
	const cell = cellSchema.safeParse(input);
	if (!cell.success) return null;
	const names = await refusedCalls(cell.data.language, cell.data.code, load);
	return names.length === 0 ? null : refusal(cell.data.language, names);
}

function resolveContext(ctx: ExtensionContext): ResolveContext {
	const session = callerSession(ctx);
	return {
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
		sessionId: ctx.sessionManager.getSessionId(),
		settings: session?.settings,
		skills: session?.skills,
		agentRegistry: AgentRegistry.global(),
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

async function scriptPath(target: LoadTarget, ctx: ExtensionContext): Promise<string | null> {
	switch (target.kind) {
		case "cell": {
			const router = InternalUrlRouter.instance();
			if (router.canHandle(target.file)) return router.requireLocal(target.file, "load", resolveContext(ctx));
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target.file) && !target.file.startsWith("file://")) return null;
			return resolveReadPathAsync(target.file, ctx.cwd);
		}
		case "line":
			return path.resolve(ctx.cwd, target.file.replace(/^~(?=$|\/)/, os.homedir()));
		default: {
			const unreachable: never = target;
			return unreachable;
		}
	}
}

const loader =
	(ctx: ExtensionContext): Load =>
	async (target) => {
		try {
			const file = await scriptPath(target, ctx);
			return file === null ? null : { path: file, code: await Bun.file(file).text() };
		} catch {
			return null;
		}
	};

export function registerEvalGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		try {
			const reason = await inspectEval(event.toolName, event.input, loader(ctx));
			return reason === null ? undefined : { block: true, reason };
		} catch (error) {
			pi.logger.warn("flow: the eval guard skipped a cell", { error: errorText(error) });
			return undefined;
		}
	});
}
