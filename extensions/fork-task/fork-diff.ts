import type { Delta } from "../../omomp-shared/context-delta.ts";
import type { ContextFragment } from "./replica.ts";

/** A working directory and the root of the git repository holding it, when there is one. */
export type WorkingDirectory = { readonly path: string; readonly repoRoot: string | undefined };

/**
 * What the child's replicated request carries from its source: the working directory the conversation ran in,
 * the declared tools and the context files of the system prompt.
 */
export type ForkBaseline = {
	readonly cwd: WorkingDirectory;
	readonly tools: readonly string[];
	readonly contextFiles: readonly ContextFragment[];
};

export type ContextFile = { readonly path: string; readonly content: string };

/** What the child actually has: its working directory, the tools the host registered for it and the context files there. */
export type ForkCurrent = {
	readonly cwd: WorkingDirectory;
	readonly tools: readonly string[];
	readonly contextFiles: readonly ContextFile[];
};

/**
 * An isolated workspace is a copy of the source's repository, so a path under the source's repository root
 * names the same relative path under the child's.
 */
function workingDirectoryChange(source: WorkingDirectory, current: WorkingDirectory): string | undefined {
	if (source.path === current.path) return;
	const moved = `The conversation above ran in \`${source.path}\`; your working directory is \`${current.path}\`.`;
	if (source.repoRoot === undefined || current.repoRoot === undefined || source.repoRoot === current.repoRoot) return moved;
	return `${moved} A path under \`${source.repoRoot}\` in the conversation is the same relative path under \`${current.repoRoot}\` for you.`;
}

/** Tools the baseline declares that the child has no registration for, in declaration order. */
export function unavailableTools(baseline: ForkBaseline, registered: readonly string[]): string[] {
	const own = new Set(registered);
	return baseline.tools.filter((name) => !own.has(name));
}

type FileChange =
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "relocated"; readonly path: string; readonly file: ContextFile }
	| { readonly kind: "added"; readonly file: ContextFile }
	| { readonly kind: "changed"; readonly file: ContextFile };

function carries(fragment: ContextFragment, file: ContextFile): boolean {
	return fragment.text.includes(file.content.trim());
}

/**
 * Paths are matched first. A baseline file absent at its path but whose content an unmatched current file
 * repeats is relocated (an isolated workspace holds the same file elsewhere); an unmatched current file whose
 * content the source prompt already carries adds nothing.
 */
function contextChanges(baseline: readonly ContextFragment[], current: readonly ContextFile[]): FileChange[] {
	const now = new Map(current.map((file) => [file.path, file]));
	const before = new Set(baseline.map((fragment) => fragment.path));
	const unmatched = current.filter((file) => !before.has(file.path));
	const claimed = new Set<ContextFile>();
	const changes: FileChange[] = [];
	for (const fragment of baseline) {
		const file = now.get(fragment.path);
		if (file) {
			if (!carries(fragment, file)) changes.push({ kind: "changed", file });
			continue;
		}
		const moved = unmatched.find((candidate) => !claimed.has(candidate) && carries(fragment, candidate));
		if (moved) {
			claimed.add(moved);
			changes.push({ kind: "relocated", path: fragment.path, file: moved });
		} else {
			changes.push({ kind: "missing", path: fragment.path });
		}
	}
	for (const file of unmatched) {
		if (claimed.has(file) || baseline.some((fragment) => carries(fragment, file))) continue;
		changes.push({ kind: "added", file });
	}
	return changes;
}

function describeChange(change: FileChange): string {
	switch (change.kind) {
		case "missing":
			return `- \`${change.path}\`: in the parent's system prompt, but not under your working directory.`;
		case "relocated":
			return `- \`${change.path}\`: under your working directory as \`${change.file.path}\`, with the same content.`;
		case "added":
			return `- \`${change.file.path}\`: under your working directory, but not in the parent's system prompt. Its content:\n${change.file.content}`;
		case "changed":
			return `- \`${change.file.path}\`: its content differs from the copy in the parent's system prompt. Its current content:\n${change.file.content}`;
		default: {
			const unreachable: never = change;
			return unreachable;
		}
	}
}

/**
 * The difference between what the replicated request tells the child and what it has.
 * `restored` names tools reported unavailable earlier in this session that are registered now.
 */
export function forkDiff(baseline: ForkBaseline, current: ForkCurrent, restored: readonly string[]): Delta {
	const sections: string[] = [];
	const moved = workingDirectoryChange(baseline.cwd, current.cwd);
	if (moved !== undefined) sections.push(moved);
	const missing = unavailableTools(baseline, current.tools);
	if (missing.length > 0) {
		sections.push(
			[
				"These tools are declared to you because your tool declaration stays identical to the parent's request, but not registered in this session; a call to any of them does not run and fails with `Tool <name> not found`:",
				...missing.map((name) => `- \`${name}\``),
			].join("\n"),
		);
	}
	if (restored.length > 0) {
		sections.push(
			["These tools, reported unavailable earlier, are registered in this session now:", ...restored.map((name) => `- \`${name}\``)].join(
				"\n",
			),
		);
	}
	const changes = contextChanges(baseline.contextFiles, current.contextFiles);
	if (changes.length > 0) {
		sections.push(["Context files differ from the parent's system prompt:", ...changes.map(describeChange)].join("\n"));
	}
	if (sections.length === 0) return { kind: "none" };
	return { kind: "text", body: ["Your session differs from the parent's request you continue.", ...sections].join("\n\n") };
}
