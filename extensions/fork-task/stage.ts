import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentSession, createAgentSession, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { hasErrorCode } from "./errors.ts";
import { forkNotice } from "./notice.ts";
import type { ForkNotice, Replica } from "./replica.ts";
import type { ForkSource } from "./source.ts";
import { finalizeStaging } from "./staging.ts";
import type { ForkWorkspace } from "./workspace.ts";

export type PendingFork = {
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

export function allocatedFrom(id: string, name: string): boolean {
	return (/^\d+$/.test(name) ? [name, `Agent${name}`] : [name]).some((base) => {
		if (id === base) return true;
		const suffix = id.startsWith(`${base}-`) ? id.slice(base.length + 1) : "";
		return /^[1-9]\d*$/.test(suffix);
	});
}

export function claimsName(pending: readonly PendingFork[], artifactsDir: string, name: string): boolean {
	const lower = name.toLowerCase();
	return pending.some(
		(entry) =>
			entry.artifactsDir === artifactsDir &&
			(allocatedFrom(entry.name.toLowerCase(), lower) || allocatedFrom(lower, entry.name.toLowerCase())),
	);
}

export async function moveFile(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (error) {
		if (!hasErrorCode(error, "EXDEV")) throw error;
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

export async function stageFork(
	ctx: ExtensionContext,
	parent: AgentSession,
	artifactsDir: string,
	source: ForkSource,
	options: { readonly shake: boolean; readonly workspace: ForkWorkspace },
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
				content: forkNotice(source, parentCwd, options.workspace),
				attribution: "agent",
				timestamp,
			});
			notice = { entryId, timestamp };
			await manager.flush();
			if (options.shake) {
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
		await finalizeStaging(staging, { cwd: parentCwd, isolated: options.workspace.kind !== "shared", preShakeIds });
		return { staging, notice, shakeSummary };
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

export async function discardPending(pending: PendingFork[], entry: PendingFork): Promise<void> {
	const index = pending.indexOf(entry);
	if (index !== -1) pending.splice(index, 1);
	const stagingDir = path.dirname(entry.staging);
	await fs.rm(stagingDir, { recursive: true, force: true });
	await fs.rmdir(path.dirname(stagingDir)).catch((error: unknown) => {
		if (hasErrorCode(error, "ENOTEMPTY", "ENOENT")) return;
		throw error;
	});
}
