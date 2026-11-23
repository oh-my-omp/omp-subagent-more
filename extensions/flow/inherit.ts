import { getRepoRoot } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { errorText } from "../fork-task/errors.ts";
import { readOptional } from "../fork-task/replica-file.ts";
import { gitApply, type Inheritance } from "../fork-task/workspace.ts";

export async function inheritReleasedPatch(patchFile: string, callerCwd: string): Promise<Inheritance | undefined> {
	const patch = await readOptional(patchFile);
	if (patch === undefined) return undefined;
	if (!patch.trim()) return { kind: "inherit", patch: "" };
	let callerRoot: string;
	try {
		callerRoot = await getRepoRoot(callerCwd);
	} catch (error) {
		return { kind: "rejected", code: "overlay-conflict", detail: `your workspace is not a git checkout: ${errorText(error)}` };
	}
	const check = await gitApply(callerRoot, patch, true);
	return check.kind === "ok"
		? { kind: "inherit", patch }
		: {
				kind: "rejected",
				code: "overlay-conflict",
				detail: `the changes kept in \`${patchFile}\` do not apply to your checkout: ${check.message}`,
			};
}

async function gitText(root: string, args: readonly string[]): Promise<string | undefined> {
	const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
	const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	return code === 0 ? stdout : undefined;
}

export async function keptTaskBranch(agentId: string, callerCwd: string): Promise<string | undefined> {
	const branch = `omp/task/${agentId}`;
	return (await gitText(callerCwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) === undefined ? undefined : branch;
}

export async function inheritKeptBranch(branch: string, callerCwd: string): Promise<Inheritance> {
	const rejected = (detail: string): Inheritance => ({ kind: "rejected", code: "overlay-conflict", detail });
	const base = (await gitText(callerCwd, ["merge-base", "HEAD", branch]))?.trim();
	if (!base) return rejected(`branch \`${branch}\` shares no history with your checkout`);
	const patch = await gitText(callerCwd, ["diff", "--binary", base, branch]);
	if (patch === undefined) return rejected(`the changes on branch \`${branch}\` cannot be read`);
	if (!patch.trim()) return { kind: "inherit", patch: "" };
	const check = await gitApply(callerCwd, patch, true);
	return check.kind === "ok"
		? { kind: "inherit", patch }
		: rejected(`the changes on branch \`${branch}\` do not apply to your checkout: ${check.message}`);
}
