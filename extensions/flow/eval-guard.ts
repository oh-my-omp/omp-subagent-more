import { z } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { astMatch } from "@oh-my-pi/pi-natives";
import { errorText } from "../fork-task/errors.ts";

export type Spawner = "agent" | "workpool";

const SPAWNERS: readonly Spawner[] = ["agent", "workpool"];

const cellSchema = z.object({ language: z.enum(["py", "js"]), code: z.string() }).passthrough();

type Language = z.infer<typeof cellSchema>["language"];

const GRAMMAR: Readonly<Record<Language, string>> = { py: "python", js: "typescript" };

const patterns = (language: Language, name: Spawner): string[] =>
	language === "js" ? [`${name}($$$ARGS)`, `globalThis.${name}($$$ARGS)`] : [`${name}($$$ARGS)`];

export async function spawnersCalled(language: Language, code: string): Promise<Spawner[]> {
	const found = await Promise.all(
		SPAWNERS.map(async (name) => {
			const result = await astMatch({ source: code, lang: GRAMMAR[language], patterns: patterns(language, name), limit: 1 });
			return result.totalMatches > 0 ? [name] : [];
		}),
	);
	return found.flat();
}

export const refusal = (names: readonly Spawner[]): string =>
	[
		`This eval cell was not run: it calls ${names.map((name) => `\`${name}()\``).join(" and ")} from the eval prelude. Subagents started from an eval cell are cancelled when the cell is interrupted; start them through the flow tool instead:`,
		"help://flow/eval",
	].join("\n");

export async function inspectEval(toolName: string, input: unknown): Promise<string | null> {
	if (toolName !== "eval") return null;
	const cell = cellSchema.safeParse(input);
	if (!cell.success) return null;
	const names = await spawnersCalled(cell.data.language, cell.data.code);
	return names.length === 0 ? null : refusal(names);
}

export function registerEvalGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		try {
			const reason = await inspectEval(event.toolName, event.input);
			return reason === null ? undefined : { block: true, reason };
		} catch (error) {
			pi.logger.warn("flow: the eval guard skipped a cell", { error: errorText(error) });
			return undefined;
		}
	});
}
