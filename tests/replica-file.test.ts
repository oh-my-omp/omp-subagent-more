import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Replica } from "../extensions/fork-task/replica.ts";
import { parsePortableSource, readReplicaFile, replicaFilePath, writeReplicaFile } from "../extensions/fork-task/replica-file.ts";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "osm-replica-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const REQUEST = {
	model: { provider: "p", id: "m", api: "openai-completions" },
	context: { systemPrompt: ["sys"], messages: [{ role: "user", content: "hi" }], tools: [{ name: "read" }] },
	options: { reasoning: "high" },
} as unknown as Replica["request"];

const CONTEXT_FILES = [{ path: "/w/AGENTS.md", text: "<file>rules</file>" }];

const replica = (replay: Replica["replay"]): Replica => ({
	request: REQUEST,
	systemPrompt: ["sys"],
	contextFiles: CONTEXT_FILES,
	cwd: "/w",
	sourceModel: "p/m:high",
	replay,
	inheritReasoning: true,
});

describe("replica copies", () => {
	test("a prefix replica round-trips, keeping an undefined response key", async () => {
		const file = path.join(dir, "copy.json");
		await writeReplicaFile(file, replica({ kind: "prefix", response: undefined, notice: { entryId: "n1", timestamp: 7 } }));
		const copy = await readReplicaFile(file);
		expect(copy).toEqual({
			request: REQUEST,
			systemPrompt: ["sys"],
			contextFiles: CONTEXT_FILES,
			cwd: "/w",
			sourceModel: "p/m:high",
			replay: { kind: "prefix", response: undefined, notice: { entryId: "n1", timestamp: 7 } },
			inheritReasoning: true,
		});
		expect(copy?.replay).toHaveProperty("response");
	});

	test("an own replica round-trips", async () => {
		const file = path.join(dir, "own.json");
		await writeReplicaFile(file, replica({ kind: "own" }));
		expect((await readReplicaFile(file))?.replay).toEqual({ kind: "own" });
	});

	test("no copy for a child is undefined; a malformed copy throws", async () => {
		expect(await readReplicaFile(path.join(dir, "missing.json"))).toBeUndefined();
		const bad = path.join(dir, "bad.json");
		await fs.writeFile(bad, JSON.stringify({ request: REQUEST }));
		await expect(readReplicaFile(bad)).rejects.toThrow();
	});

	test("a child's copy lives in that child's own session artifacts directory", () => {
		expect(replicaFilePath("/s/a.jsonl")).toBe("/s/a/fork-task.replica.json");
		expect(() => replicaFilePath("/s/a.json")).toThrow("not a session transcript");
	});
});

describe("parsePortableSource", () => {
	const source = { request: REQUEST, response: 5, systemPrompt: ["sys"], contextFiles: CONTEXT_FILES, cwd: "/w" };

	test("accepts a known thinking level and an absent one", () => {
		expect(parsePortableSource({ ...source, thinkingLevel: "high" }).thinkingLevel as string | undefined).toBe("high");
		expect(parsePortableSource(source).thinkingLevel).toBeUndefined();
	});

	test("refuses an unknown thinking level and a missing cwd", () => {
		expect(() => parsePortableSource({ ...source, thinkingLevel: "turbo" })).toThrow("unknown thinking level");
		const { cwd: _cwd, ...noCwd } = source;
		expect(() => parsePortableSource(noCwd)).toThrow();
	});
});
