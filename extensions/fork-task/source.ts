import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { type ForkWorkspace, type Inheritance, inheritSourceWorkspace, type Rejected, type WorkspacePlan } from "../_shared/workspace.ts";
import { liveRequest, observedHere, type ParkedRequest, parkedRequest, type SourceRequest } from "./replica.ts";
import { askSource } from "./source-channel.ts";

export type ForkSource =
	| { readonly kind: "caller"; readonly request: SourceRequest; readonly file: string; readonly cwd: string }
	| { readonly kind: "agent"; readonly id: string; readonly request: SourceRequest; readonly file: string; readonly cwd: string }
	| { readonly kind: "parked"; readonly id: string; readonly request: SourceRequest; readonly file: string; readonly cwd: string };

type SourceResolution = { readonly kind: "error"; readonly message: string } | ForkSource;

export async function resolveSource(from: string | undefined, parent: AgentSession, parentFile: string): Promise<SourceResolution> {
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

async function sourceInheritance(source: ForkSource, callerCwd: string): Promise<Inheritance> {
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

export async function placeWorkspace(plan: WorkspacePlan, source: ForkSource, callerCwd: string): Promise<ForkWorkspace | Rejected> {
	switch (plan.kind) {
		case "shared":
		case "isolated":
			return plan;
		case "inherit": {
			const inheritance = await sourceInheritance(source, callerCwd);
			return inheritance.kind === "inherit" ? { kind: "inherited", patch: inheritance.patch } : inheritance;
		}
		default: {
			const unreachable: never = plan;
			return unreachable;
		}
	}
}
