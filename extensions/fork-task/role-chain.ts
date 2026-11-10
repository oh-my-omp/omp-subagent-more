/**
 * One completion over the chat models of OMP model roles, in order: each role's
 * own chain (`modelRoles.<role>`, `retry.fallbackChains.<role>`, then OMP's
 * defaults for a built-in role), resolved from the calling session's live
 * settings at every call so a `/model` change applies to the next request. An
 * unassigned custom role (`omp-subagent-more`) contributes nothing; on-device
 * and native judgment models are skipped. Each model's attempt gets the time
 * left to the deadline divided over the models not yet tried, so a hanging or
 * failing provider costs only its share and the chain moves on.
 */
import { completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { MODEL_ROLE_IDS, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { kindOf } from "@oh-my-pi/pi-coding-agent/judgment";
import { callerSession } from "./caller-session.ts";
import { errorText } from "./errors.ts";

type Effort = (typeof THINKING_EFFORTS)[number];

/** Effort used when a role entry has no `:level` suffix. */
export const MEDIUM_EFFORT: Effort =
	THINKING_EFFORTS.find((effort) => effort === "medium") ??
	(() => {
		throw new Error("omp-subagent-more: host does not recognize medium reasoning effort");
	})();
type Level = "off" | Effort;
type Candidate = { readonly model: Model; readonly level: Level | undefined };

/** Outcome of one pass over the chain; `failures` holds one `provider/id: reason` line per model that failed. */
export type ChainReply =
	| { readonly kind: "text"; readonly text: string; readonly model: string; readonly failures: readonly string[] }
	| { readonly kind: "no-model" }
	| { readonly kind: "deadline" }
	| { readonly kind: "all-failed"; readonly failures: readonly string[] }
	| { readonly kind: "error"; readonly error: string };

const label = (model: Model): string => `${model.provider}/${model.id}`;

/** Text blocks of an assistant reply's content, joined; thinking and tool calls are dropped. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join("");
}

function candidates(ctx: ExtensionContext, roles: readonly string[]): Candidate[] {
	const settings = callerSession(ctx)?.settings;
	if (settings === undefined) throw new Error("model roles: current OMP session is not registered");
	const out: Candidate[] = [];
	const seen = new Set<string>();
	for (const role of roles) {
		const builtIn = MODEL_ROLE_IDS.some((id) => id === role);
		for (const candidate of resolveRoleChain(role, settings, roleCandidatePool(role, settings, ctx.modelRegistry))) {
			if (!builtIn && !candidate.explicit) continue;
			if (kindOf(candidate) !== "online") continue;
			const key = label(candidate.model);
			if (seen.has(key)) continue;
			seen.add(key);
			const level = candidate.thinkingLevel;
			out.push({ model: candidate.model, level: level === "off" ? "off" : THINKING_EFFORTS.find((effort) => effort === level) });
		}
	}
	return out;
}

/**
 * Asks the models of `roles` in order until one answers with `stopReason: "stop"`;
 * a reply cut off by `length` or ending in `toolUse` is a failed attempt.
 */
export async function completeRoles(
	ctx: ExtensionContext,
	roles: readonly string[],
	systemPrompt: string,
	prompt: string,
	effort: Effort,
	deadlineAt: number,
	signal: AbortSignal,
): Promise<ChainReply> {
	const failures: string[] = [];
	try {
		const models = candidates(ctx, roles);
		if (models.length === 0) return { kind: "no-model" };
		for (const [position, { model, level }] of models.entries()) {
			if (signal.aborted) return { kind: "deadline" };
			const remaining = models.length - position;
			const attempt = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, (deadlineAt - Date.now()) / remaining))]);
			try {
				const apiKey = ctx.modelRegistry.resolver(model);
				const reply = await completeSimple(
					model,
					{ systemPrompt: [systemPrompt], messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
					level === "off" ? { apiKey, disableReasoning: true, signal: attempt } : { apiKey, reasoning: level ?? effort, signal: attempt },
				);
				switch (reply.stopReason) {
					case "stop":
						return { kind: "text", text: textOf(reply.content), model: label(model), failures };
					case "length":
					case "toolUse":
						failures.push(`${label(model)}: ${reply.stopReason}`);
						continue;
					case "error":
						failures.push(`${label(model)}: ${reply.errorMessage ?? "error"}`);
						continue;
					case "aborted":
						if (signal.aborted || (remaining === 1 && attempt.aborted)) return { kind: "deadline" };
						failures.push(`${label(model)}: attempt timeout`);
						continue;
					default: {
						const unreachable: never = reply.stopReason;
						throw new Error(`unknown stop reason: ${String(unreachable)}`);
					}
				}
			} catch (error) {
				if (signal.aborted || (remaining === 1 && attempt.aborted)) return { kind: "deadline" };
				failures.push(`${label(model)}: ${errorText(error)}`);
			}
		}
		return { kind: "all-failed", failures };
	} catch (error) {
		return signal.aborted ? { kind: "deadline" } : { kind: "error", error: errorText(error) };
	}
}
