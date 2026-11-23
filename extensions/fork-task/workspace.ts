import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import { hasLiveIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import {
	captureDeltaPatch,
	captureIsolationBaseline,
	type DeltaPatchResult,
	getRepoRoot,
	taskIsolationBaseDir,
	type WorktreeBaseline,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import { Shell } from "@oh-my-pi/pi-natives";
import { errorText } from "./errors.ts";
import type { WorkingDirectory } from "./fork-diff.ts";
import { readOptional, sessionArtifactsDir } from "./replica-file.ts";

export type RejectionCode =
	| "child-not-isolated"
	| "source-not-isolated"
	| "source-running"
	| "source-handed-back"
	| "nested-repo"
	| "overlay-conflict";

export const rejection = (code: RejectionCode, detail: string): string => `workspace "isolated_from_source" rejected (${code}): ${detail}`;

export type Rejected = { readonly kind: "rejected"; readonly code: RejectionCode; readonly detail: string };

export type Inheritance = { readonly kind: "inherit"; readonly patch: string } | Rejected;

export type WorkspaceRequest = "shared" | "isolated_from_caller" | "isolated_from_source";

export type WorkspacePlan = { readonly kind: "shared" } | { readonly kind: "isolated" } | { readonly kind: "inherit" };

export type ForkWorkspace =
	| { readonly kind: "shared" }
	| { readonly kind: "isolated" }
	| { readonly kind: "inherited"; readonly patch: string };

const rejected = (code: RejectionCode, detail: string): Rejected => ({ kind: "rejected", code, detail });

export function resolveForkWorkspace(
	requested: WorkspaceRequest | undefined,
	hasRole: boolean,
	planMode: boolean,
): WorkspacePlan | Rejected {
	const chosen = requested ?? (hasRole ? "isolated_from_caller" : "shared");
	switch (chosen) {
		case "shared":
			return { kind: "shared" };
		case "isolated_from_caller":
			return planMode ? { kind: "shared" } : { kind: "isolated" };
		case "isolated_from_source":
			return planMode
				? rejected("child-not-isolated", "plan mode runs every child in your workspace; inheriting needs an isolated child.")
				: { kind: "inherit" };
		default: {
			const unreachable: never = chosen;
			return unreachable;
		}
	}
}

export type InheritSource = {
	readonly id: string;
	readonly file: string;
	readonly cwd: string;
	readonly running: boolean;
	readonly handedBack: boolean;
};

type Isolation = { readonly kind: "isolated"; readonly root: string; readonly parentRoot: string } | { readonly kind: "shared" };

const repoBaselineSchema = z.object({
	repoRoot: z.string(),
	headCommit: z.string(),
	staged: z.string(),
	unstaged: z.string(),
	untracked: z.array(z.string()),
	untrackedPatch: z.string(),
});

const baselineSchema = z.object({
	root: repoBaselineSchema,
	nested: z.array(z.object({ relativePath: z.string(), baseline: repoBaselineSchema })),
});

const headerSchema = z.object({ type: z.literal("session"), cwd: z.string() }).passthrough();

function startFilePath(sessionFile: string): string {
	return path.join(sessionArtifactsDir(sessionFile), "fork-task.start.json");
}

export function overlayFilePath(childFile: string): string {
	return path.join(sessionArtifactsDir(childFile), "fork-task.overlay.patch");
}

export async function workingDirectory(cwd: string): Promise<WorkingDirectory> {
	try {
		return { path: cwd, repoRoot: await getRepoRoot(cwd) };
	} catch {
		return { path: cwd, repoRoot: undefined };
	}
}

export async function headerCwd(sessionFile: string): Promise<string | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(sessionFile);
	} catch {
		return undefined;
	}
	try {
		for await (const line of handle.readLines()) {
			if (!line.trim()) continue;
			const header = headerSchema.safeParse(JSON.parse(line));
			if (header.success) return header.data.cwd;
		}
		return undefined;
	} finally {
		await handle.close();
	}
}

async function isolationOf(sessionFile: string, cwd: string, id: string): Promise<Isolation> {
	const parentCwd = await headerCwd(`${path.dirname(sessionFile)}.jsonl`);
	if (parentCwd === undefined) return { kind: "shared" };
	let parentRoot: string;
	let root: string;
	try {
		parentRoot = await getRepoRoot(parentCwd);
		root = await getRepoRoot(cwd);
	} catch {
		return { kind: "shared" };
	}
	if (path.resolve(root) === path.resolve(parentRoot)) return { kind: "shared" };
	if (!(await hasLiveIsolationOwner(taskIsolationBaseDir(parentRoot, id)))) return { kind: "shared" };
	return { kind: "isolated", root, parentRoot };
}

export async function recordStart(sessionFile: string, cwd: string, id: string): Promise<void> {
	const file = startFilePath(sessionFile);
	if ((await readOptional(file)) !== undefined) return;
	const isolation = await isolationOf(sessionFile, cwd, id);
	if (isolation.kind === "shared") return;
	const baseline: WorktreeBaseline = await captureIsolationBaseline(isolation.root, isolation.parentRoot);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(baseline));
}

type GitApply = { readonly kind: "ok" } | { readonly kind: "failed"; readonly message: string };

export async function gitApply(root: string, patch: string, check: boolean): Promise<GitApply> {
	const child = Bun.spawn(["git", "-C", root, "apply", ...(check ? ["--check"] : []), "-"], {
		stdin: Buffer.from(patch),
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return code === 0 ? { kind: "ok" } : { kind: "failed", message: stderr.trim() || `git apply exited with ${code}` };
}

export async function inheritSourceWorkspace(source: InheritSource, callerCwd: string): Promise<Inheritance> {
	if (source.running) return rejected("source-running", `agent \`${source.id}\` is still running; fork it once it stopped.`);
	if (source.handedBack)
		return rejected(
			"source-handed-back",
			`agent \`${source.id}\` already handed this run's changes back; they are in your checkout or its task branch.`,
		);
	if ((await isolationOf(source.file, source.cwd, source.id)).kind === "shared")
		return rejected("source-not-isolated", `agent \`${source.id}\` has no isolated workspace of its own.`);
	const recorded = await readOptional(startFilePath(source.file));
	if (recorded === undefined)
		return rejected(
			"overlay-conflict",
			`no start of agent \`${source.id}\`'s workspace was recorded in this OMP process, so its changes cannot be read.`,
		);
	let delta: DeltaPatchResult;
	try {
		const sourceRoot = await getRepoRoot(source.cwd);
		delta = await captureDeltaPatch(sourceRoot, baselineSchema.parse(JSON.parse(recorded)));
	} catch (error) {
		return rejected("overlay-conflict", `reading agent \`${source.id}\`'s changes failed: ${errorText(error)}`);
	}
	if (delta.nestedPatches.length > 0) {
		const repos = delta.nestedPatches.map((nested) => `\`${nested.relativePath}\``).join(", ");
		return rejected("nested-repo", `agent \`${source.id}\` changed nested repositories (${repos}), which a fork does not inherit.`);
	}
	if (!delta.rootPatch.trim()) return { kind: "inherit", patch: "" };
	let callerRoot: string;
	try {
		callerRoot = await getRepoRoot(callerCwd);
	} catch (error) {
		return rejected("overlay-conflict", `your workspace is not a git checkout: ${errorText(error)}`);
	}
	const check = await gitApply(callerRoot, delta.rootPatch, true);
	if (check.kind === "failed")
		return rejected("overlay-conflict", `agent \`${source.id}\`'s changes do not apply to your checkout: ${check.message}`);
	return { kind: "inherit", patch: delta.rootPatch };
}

export type OverlayResult =
	| { readonly kind: "none" }
	| { readonly kind: "applied" }
	| { readonly kind: "failed"; readonly message: string };

export async function applyOverlay(childFile: string, cwd: string): Promise<OverlayResult> {
	const file = overlayFilePath(childFile);
	const patch = await readOptional(file);
	if (patch === undefined) return { kind: "none" };
	await fs.rm(file, { force: true });
	let root: string;
	try {
		root = await getRepoRoot(cwd);
	} catch (error) {
		return { kind: "failed", message: errorText(error) };
	}
	const applied = await gitApply(root, patch, false);
	return applied.kind === "ok" ? { kind: "applied" } : { kind: "failed", message: applied.message };
}

export async function writeOverlay(childFile: string, patch: string): Promise<void> {
	const file = overlayFilePath(childFile);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, patch);
}

function prepareFilePath(childFile: string): string {
	return path.join(sessionArtifactsDir(childFile), "fork-task.prepare");
}

export async function writePrepare(childFile: string, command: string): Promise<void> {
	const file = prepareFilePath(childFile);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, command);
}

export type PrepareResult = { readonly kind: "none" } | { readonly kind: "ran" } | { readonly kind: "failed"; readonly message: string };

const PREPARE_TIMEOUT_MS = 240_000;
const PREPARE_OUTPUT_KEPT = 6000;

export async function runPrepare(childFile: string, cwd: string): Promise<PrepareResult> {
	const file = prepareFilePath(childFile);
	const command = await readOptional(file);
	if (command === undefined) return { kind: "none" };
	await fs.rm(file, { force: true });
	let output = "";
	const result = await new Shell().run({ command, cwd, timeoutMs: PREPARE_TIMEOUT_MS }, (error, chunk) => {
		if (error === null) output += chunk;
	});
	if (result.exitCode === 0 && !result.timedOut && !result.cancelled) return { kind: "ran" };
	const how = result.timedOut ? "timed out" : `exited with ${result.exitCode ?? "no status"}`;
	return { kind: "failed", message: `the \`prepare\` command ${how} in this workspace: ${output.trim().slice(-PREPARE_OUTPUT_KEPT)}` };
}
