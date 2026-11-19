import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyOverlay,
	inheritKeptBranch,
	inheritSourceWorkspace,
	keptTaskBranch,
	overlayFilePath,
	rejection,
	writeOverlay,
} from "../extensions/fork-task/workspace.ts";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "osm-workspace-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
	const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
	if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}

async function repo(): Promise<string> {
	const root = path.join(dir, "repo");
	await fs.mkdir(root);
	await git(root, "init", "-q");
	await fs.writeFile(path.join(root, "a.txt"), "one\n");
	await git(root, "add", "a.txt");
	await git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	return root;
}

const PATCH = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-one", "+two", ""].join("\n");

describe("inheritSourceWorkspace rejections", () => {
	const source = { id: "Worker", file: "/nowhere/parent/Worker.jsonl", cwd: "/nowhere", running: false, handedBack: false };

	test("a running source is refused first", async () => {
		expect(await inheritSourceWorkspace({ ...source, running: true, handedBack: true }, dir)).toMatchObject({
			kind: "rejected",
			code: "source-running",
		});
	});

	test("a source whose changes were handed back is refused", async () => {
		expect(await inheritSourceWorkspace({ ...source, handedBack: true }, dir)).toMatchObject({
			kind: "rejected",
			code: "source-handed-back",
		});
	});

	test("a source without a persisted parent transcript has no isolated workspace", async () => {
		expect(await inheritSourceWorkspace(source, dir)).toMatchObject({ kind: "rejected", code: "source-not-isolated" });
	});

	test("rejection text carries the code", () => {
		expect(rejection("overlay-conflict", "x")).toBe('workspace "source" rejected (overlay-conflict): x');
	});
});

describe("a task branch OMP kept because it could not merge it", () => {
	const commit = (root: string, message: string): Promise<void> =>
		git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", message);

	async function withKeptBranch(): Promise<string> {
		const root = await repo();
		await git(root, "checkout", "-q", "-b", "omp/task/Worker");
		await fs.writeFile(path.join(root, "a.txt"), "two\n");
		await fs.writeFile(path.join(root, "b.txt"), "new\n");
		await git(root, "add", "b.txt");
		await commit(root, "task");
		await git(root, "checkout", "-q", "-");
		return root;
	}

	test("is found by the session's id, and only while it exists", async () => {
		const root = await withKeptBranch();
		expect(await keptTaskBranch("Worker", root)).toBe("omp/task/Worker");
		expect(await keptTaskBranch("Other", root)).toBeUndefined();
	});

	test("hands its changes on as a patch that applies to the checkout", async () => {
		const root = await withKeptBranch();
		const inherited = await inheritKeptBranch("omp/task/Worker", root);
		expect(inherited.kind).toBe("inherit");
		const child = path.join(dir, `child-${crypto.randomUUID()}.jsonl`);
		await writeOverlay(child, inherited.kind === "inherit" ? inherited.patch : "");
		expect(await applyOverlay(child, root)).toEqual({ kind: "applied" });
		expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("two\n");
		expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("new\n");
	});

	test("carries only what the branch added when the checkout has moved on since", async () => {
		const root = await withKeptBranch();
		await fs.writeFile(path.join(root, "c.txt"), "later\n");
		await git(root, "add", "c.txt");
		await commit(root, "later");
		const inherited = await inheritKeptBranch("omp/task/Worker", root);
		expect(inherited.kind === "inherit" ? inherited.patch : "").not.toContain("c.txt");
		expect(inherited.kind === "inherit" ? inherited.patch : "").toContain("b.txt");
	});

	test("is refused when its changes no longer apply to the checkout", async () => {
		const root = await withKeptBranch();
		await fs.writeFile(path.join(root, "a.txt"), "changed here\n");
		await commit(root, "conflicting");
		expect(await inheritKeptBranch("omp/task/Worker", root)).toMatchObject({ kind: "rejected", code: "overlay-conflict" });
	});
});

describe("overlay files", () => {
	test("no overlay for a child is `none`", async () => {
		expect(await applyOverlay(path.join(dir, "child-none.jsonl"), dir)).toEqual({ kind: "none" });
	});

	test("an overlay applies once to the child's checkout and is consumed", async () => {
		const root = await repo();
		const child = path.join(dir, `child-${crypto.randomUUID()}.jsonl`);
		await writeOverlay(child, PATCH);
		expect(await applyOverlay(child, root)).toEqual({ kind: "applied" });
		expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("two\n");
		expect(await fs.exists(overlayFilePath(child))).toBe(false);
		expect(await applyOverlay(child, root)).toEqual({ kind: "none" });
	});

	test("an overlay that does not apply fails with git's message, leaves the checkout and is still consumed", async () => {
		const root = await repo();
		await fs.writeFile(path.join(root, "a.txt"), "changed\n");
		const child = path.join(dir, `child-${crypto.randomUUID()}.jsonl`);
		await writeOverlay(child, PATCH);
		const result = await applyOverlay(child, root);
		expect(result.kind).toBe("failed");
		expect(result.kind === "failed" ? result.message : "").toContain("a.txt");
		expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("changed\n");
		expect(await fs.exists(overlayFilePath(child))).toBe(false);
	});

	test("an overlay for a directory outside git fails without touching it", async () => {
		const child = path.join(dir, `child-${crypto.randomUUID()}.jsonl`);
		await writeOverlay(child, PATCH);
		expect((await applyOverlay(child, dir)).kind).toBe("failed");
	});
});
