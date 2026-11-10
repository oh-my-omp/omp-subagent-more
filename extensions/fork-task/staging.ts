/**
 * The staging rewrite: the forked transcript loses the parent's runtime state
 * before the child opens it. Pure file transformation, no OMP state.
 */
import * as fs from "node:fs/promises";
import { z } from "@oh-my-pi/pi-coding-agent";

const sessionHeaderSchema = z
	.object({ type: z.literal("session"), cwd: z.string(), additionalDirectories: z.array(z.string()).optional() })
	.passthrough();

const sessionEntrySchema = z
	.object({
		type: z.string(),
		id: z.string(),
		parentId: z.string().nullable().optional(),
		customType: z.string().optional(),
		firstKeptEntryId: z.string().optional(),
	})
	.passthrough();
type SessionEntryRecord = z.infer<typeof sessionEntrySchema>;

/** Parent runtime state that must not seed the child's own contract. */
const RUNTIME_STATE_TYPES: Record<string, true> = {
	session_init: true,
	model_change: true,
	thinking_level_change: true,
	service_tier_change: true,
};

const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

/** Rewrite output buffered before each chunk write, so a staged file is never held whole. */
const FLUSH_CHARS = 1 << 18;
/** Bytes read per batch by the staging rewrite. */
const CHUNK_BYTES = 1 << 22;

/**
 * A UTF-8 file's lines as byte-sized batches: a rewrite visits every line while
 * holding only one batch, and a multi-byte character split across reads is
 * carried into the next batch.
 */
async function* readLineBatches(handle: fs.FileHandle, bytes = CHUNK_BYTES): AsyncGenerator<string[]> {
	const buffer = Buffer.allocUnsafe(bytes);
	const decoder = new TextDecoder();
	let carry = "";
	for (;;) {
		const { bytesRead } = await handle.read(buffer, 0, bytes, null);
		if (bytesRead === 0) break;
		const text = carry + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
		const lines = text.split("\n");
		carry = lines.pop() ?? "";
		yield lines;
	}
	carry += decoder.decode();
	if (carry.length > 0) yield [carry];
}

/**
 * Rewrite the staged JSONL: drop parent runtime state and the shake helper's
 * bookkeeping, re-parent what depended on dropped entries, and set the header
 * cwd the child must bind to. One pass, one record at a time: a JSONL session
 * appends an entry after the entries it references, so a dropped entry is
 * known before the rewrite reaches a `parentId` or `firstKeptEntryId` that
 * names it. `preShakeIds` is undefined when no shake ran: nothing was added
 * to drop then.
 */
export async function finalizeStaging(
	file: string,
	options: { cwd: string; isolated: boolean; preShakeIds: ReadonlySet<string> | undefined },
): Promise<void> {
	const temp = `${file}.rewrite`;
	const source = await fs.open(file);
	let target: fs.FileHandle;
	try {
		target = await fs.open(temp, "w");
	} catch (error) {
		// The rewrite never starts; release the reader without masking the open failure.
		await source.close().catch(() => {});
		throw error;
	}
	const chunk: string[] = [];
	let chunkLength = 0;
	const flush = async (): Promise<void> => {
		if (chunk.length === 0) return;
		const bytes = Buffer.from(`${chunk.join("\n")}\n`, "utf8");
		chunk.length = 0;
		chunkLength = 0;
		let written = 0;
		// A short write keeps its own cursor; loop so a chunk is never half written.
		while (written < bytes.length) {
			const { bytesWritten } = await target.write(bytes, written, bytes.length - written);
			if (bytesWritten === 0) throw new Error(`fork_task: writing ${temp} made no progress`);
			written += bytesWritten;
		}
	};
	const emit = (line: string): void => {
		chunk.push(line);
		chunkLength += line.length + 1;
	};
	const dropped = new Map<string, string | null>();
	const nextSurviving = new Map<string, string>();
	const survivingParent = (id: string | null): string | null => {
		let current = id;
		while (current !== null && dropped.has(current)) current = dropped.get(current) ?? null;
		return current;
	};
	let headerSeen = false;
	let pendingDropped: string[] = [];
	let failure: unknown;
	try {
		for await (const batch of readLineBatches(source)) {
			for (const line of batch) {
				if (line.length === 0) continue;
				const record: unknown = JSON.parse(line);
				const header = headerSeen ? undefined : sessionHeaderSchema.safeParse(record);
				if (header?.success) {
					headerSeen = true;
					const next = { ...header.data, cwd: options.isolated ? "" : options.cwd };
					if (options.isolated) delete next.additionalDirectories;
					emit(JSON.stringify(next));
					if (chunkLength >= FLUSH_CHARS) await flush();
					continue;
				}
				const parsed = sessionEntrySchema.safeParse(record);
				if (!parsed.success) {
					emit(line);
					if (chunkLength >= FLUSH_CHARS) await flush();
					continue;
				}
				const entry = parsed.data;
				const addedByShake = options.preShakeIds !== undefined && !options.preShakeIds.has(entry.id);
				const drop =
					RUNTIME_STATE_TYPES[entry.type] === true ||
					(addedByShake && entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
				if (drop) {
					dropped.set(entry.id, entry.parentId ?? null);
					pendingDropped.push(entry.id);
					continue;
				}
				// `firstKeptEntryId` may name a dropped entry: move it to the next surviving entry.
				for (const id of pendingDropped) nextSurviving.set(id, entry.id);
				pendingDropped = [];
				const next: SessionEntryRecord = { ...entry };
				if (next.parentId && dropped.has(next.parentId)) next.parentId = survivingParent(next.parentId);
				if (next.firstKeptEntryId && dropped.has(next.firstKeptEntryId)) {
					const replacement = nextSurviving.get(next.firstKeptEntryId);
					if (replacement) next.firstKeptEntryId = replacement;
				}
				emit(JSON.stringify(next));
				if (chunkLength >= FLUSH_CHARS) await flush();
			}
		}
		await flush();
	} catch (error) {
		failure = error;
	}
	// Close both handles whatever happened; a close failure never hides the rewrite's own error.
	for (const handle of [target, source]) {
		try {
			await handle.close();
		} catch (error) {
			if (failure === undefined) failure = error;
		}
	}
	if (failure !== undefined || !headerSeen) {
		await fs.rm(temp, { force: true }).catch(() => {});
		if (failure !== undefined) throw failure;
		throw new Error(`fork_task: ${file} has no session header`);
	}
	await fs.rename(temp, file);
}
