import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { finalizeStaging } from "../extensions/fork-task/staging.ts";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "osm-staging-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

type Line = Record<string, unknown>;

async function stage(lines: readonly Line[]): Promise<string> {
	const file = path.join(dir, "fork.jsonl");
	await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

async function records(file: string): Promise<Line[]> {
	return (await fs.readFile(file, "utf8"))
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Line);
}

const HEADER = { type: "session", version: 3, id: "s1", cwd: "/source", additionalDirectories: ["/extra"] };

describe("finalizeStaging", () => {
	test("drops the parent's runtime state and re-parents what hung on it", async () => {
		const file = await stage([
			HEADER,
			{ type: "session_init", id: "init", parentId: null },
			{ type: "model_change", id: "m", parentId: "init" },
			{ type: "message", id: "u1", parentId: "m", message: { role: "user" } },
			{ type: "thinking_level_change", id: "t", parentId: "u1" },
			{ type: "service_tier_change", id: "st", parentId: "t" },
			{ type: "message", id: "a1", parentId: "st", message: { role: "assistant" } },
		]);
		await finalizeStaging(file, { cwd: "/caller", isolated: false, preShakeIds: undefined });
		const out = await records(file);
		expect(out.map((line) => line.id ?? line.type)).toEqual(["s1", "u1", "a1"]);
		expect(out[1]?.parentId).toBeNull();
		expect(out[2]?.parentId).toBe("u1");
	});

	test("a shared child binds to the caller's cwd and keeps additional directories", async () => {
		const file = await stage([HEADER, { type: "message", id: "u1", parentId: null }]);
		await finalizeStaging(file, { cwd: "/caller", isolated: false, preShakeIds: undefined });
		const [header] = await records(file);
		expect(header).toMatchObject({ type: "session", cwd: "/caller", additionalDirectories: ["/extra"], version: 3 });
	});

	test("an isolated child gets a blank cwd and no additional directories", async () => {
		const file = await stage([HEADER, { type: "message", id: "u1", parentId: null }]);
		await finalizeStaging(file, { cwd: "/caller", isolated: true, preShakeIds: undefined });
		const [header] = await records(file);
		expect(header?.cwd).toBe("");
		expect(header).not.toHaveProperty("additionalDirectories");
	});

	test("a compaction whose firstKeptEntryId was dropped points at the next surviving entry", async () => {
		const file = await stage([
			HEADER,
			{ type: "message", id: "u1", parentId: null },
			{ type: "model_change", id: "m", parentId: "u1" },
			{ type: "message", id: "u2", parentId: "m" },
			{ type: "compaction", id: "c", parentId: "u2", firstKeptEntryId: "m" },
		]);
		await finalizeStaging(file, { cwd: "/caller", isolated: false, preShakeIds: undefined });
		const compaction = (await records(file)).find((line) => line.id === "c");
		expect(compaction?.firstKeptEntryId).toBe("u2");
	});

	test("only a session_exit the shake added is dropped; one that predates the shake stays", async () => {
		const file = await stage([
			HEADER,
			{ type: "custom", id: "old-exit", parentId: null, customType: "session_exit" },
			{ type: "message", id: "u1", parentId: "old-exit" },
			{ type: "custom", id: "shake-exit", parentId: "u1", customType: "session_exit" },
			{ type: "message", id: "shake-summary", parentId: "shake-exit" },
		]);
		await finalizeStaging(file, { cwd: "/caller", isolated: false, preShakeIds: new Set(["old-exit", "u1"]) });
		const out = await records(file);
		expect(out.map((line) => line.id)).toEqual(["s1", "old-exit", "u1", "shake-summary"]);
		expect(out[3]?.parentId).toBe("u1");
	});

	test("records that are not session entries pass through byte for byte", async () => {
		const title = { type: "title", text: "padded ".repeat(10) };
		const file = await stage([title, HEADER, { type: "message", id: "u1", parentId: null, extra: { nested: [1, 2] } }]);
		await finalizeStaging(file, { cwd: "/caller", isolated: false, preShakeIds: undefined });
		const out = await records(file);
		expect(out[0]).toEqual(title);
		expect(out[2]).toEqual({ type: "message", id: "u1", parentId: null, extra: { nested: [1, 2] } });
	});

	test("a transcript without a session header is refused and left untouched", async () => {
		const file = await stage([{ type: "message", id: "u1", parentId: null }]);
		const before = await fs.readFile(file, "utf8");
		await expect(finalizeStaging(file, { cwd: "/caller", isolated: false, preShakeIds: undefined })).rejects.toThrow("no session header");
		expect(await fs.readFile(file, "utf8")).toBe(before);
		expect(await fs.readdir(dir)).toEqual(["fork.jsonl"]);
	});

	test("multi-byte text survives the batched rewrite", async () => {
		const text = "分叉任务🙂".repeat(200_000);
		const file = await stage([HEADER, { type: "message", id: "u1", parentId: null, text }]);
		await finalizeStaging(file, { cwd: "/caller", isolated: false, preShakeIds: undefined });
		expect((await records(file))[1]?.text).toBe(text);
	});
});
