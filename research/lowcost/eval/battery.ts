import { cpSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "/tmp/delivering-issues/oh-my-omp-omp-config-323";
const BASE = `${ROOT}/base`;
const SCRATCH = `/tmp/lc-battery-${Date.now()}`;
const MODULE = "agent/extensions/_shared/ask-answers.ts";

type Details = Record<string, unknown>;
const message = (details: unknown, over: Record<string, unknown> = {}) => ({ role: "toolResult", toolName: "ask", isError: false, details, content: [], ...over });
const db = { name: "db", question: "Database", answer: "SQLite" };
const bf = { name: "bf", question: "Backfill", answer: "no" };
const note = (over: Details = {}) => ({ name: "db", question: "Database", option: "SQLite", value: "sqlite", text: "only if backups stay", ...over });

const cases: { id: string; kind: "C" | "I"; input: unknown; over?: Record<string, unknown>; expect: string | null }[] = [
	{ id: "native_basic", kind: "C", input: { answers: [db, bf] }, expect: "Database → SQLite\nBackfill → no" },
	{ id: "timedOut_true", kind: "C", input: { answers: [bf], timedOut: true }, expect: null },
	{ id: "timedOut_false", kind: "C", input: { answers: [bf], timedOut: false }, expect: "Backfill → no" },
	{ id: "notes_pair_order", kind: "C", input: { answers: [db], notes: [note(), note({ text: "and WAL on" })] }, expect: "Database → SQLite [note: SQLite — only if backups stay] [note: SQLite — and WAL on]" },
	{ id: "note_fold", kind: "C", input: { answers: [db], notes: [note({ text: "a\n\n  b" })] }, expect: "Database → SQLite [note: SQLite — a b]" },
	{ id: "note_empty_dropped", kind: "C", input: { answers: [db], notes: [note({ text: "  \n " })] }, expect: "Database → SQLite" },
	{ id: "note_unpaired_name", kind: "C", input: { answers: [db], notes: [note({ name: "zz" })] }, expect: "Database → SQLite" },
	{ id: "note_unpaired_question", kind: "C", input: { answers: [db], notes: [note({ question: "Other" })] }, expect: "Database → SQLite" },
	{ id: "blank_skipped", kind: "C", input: { answers: [{ ...db, answer: "" }, bf] }, expect: "Backfill → no" },
	{ id: "all_blank", kind: "C", input: { answers: [{ ...db, answer: "" }] }, expect: null },
	{ id: "answers_empty", kind: "C", input: { answers: [] }, expect: null },
	{ id: "other_tool", kind: "C", input: { answers: [db] }, over: { toolName: "bash" }, expect: null },
	{ id: "is_error", kind: "C", input: { answers: [db] }, over: { isError: true }, expect: null },
	{ id: "junk_details", kind: "C", input: { foo: 1 }, expect: null },
	{ id: "whitespace_only_answer", kind: "I", input: { answers: [{ ...db, answer: "  \n " }, bf] }, expect: "Backfill → no" },
	{ id: "multiline_answer_one_line", kind: "I", input: { answers: [{ ...db, answer: "l1\nl2" }] }, expect: "Database → l1 l2" },
	{ id: "note_on_blank", kind: "I", input: { answers: [{ ...db, answer: "" }], notes: [note()] }, expect: null },
];
const legacy: { id: string; input: unknown }[] = [
	{ id: "legacy_batch_custom", input: { results: [{ question: "Database", options: ["SQLite"], multi: false, selectedOptions: ["SQLite"], customInput: "in WAL" }] } },
	{ id: "legacy_single", input: { question: "Database", options: ["SQLite"], multi: false, selectedOptions: ["SQLite"] } },
	{ id: "legacy_single_custom_only", input: { question: "Database", options: ["SQLite"], multi: false, selectedOptions: [], customInput: "mine" } },
	{ id: "legacy_no_selection", input: { question: "Database", options: ["SQLite"], multi: false, selectedOptions: [] } },
	{ id: "legacy_multi_batch", input: { results: [{ question: "A", options: ["x", "y"], multi: true, selectedOptions: ["x", "y"] }, { question: "B", options: ["z"], multi: false, selectedOptions: ["z"] }] } },
];
const recorded: { id: string; input: unknown }[] = [
	{ id: "legacy_single_timedOut", input: { question: "Q", options: ["a"], multi: false, selectedOptions: ["a"], timedOut: true } },
	{ id: "both_keys", input: { answers: [db], results: [{ question: "Database", options: ["Postgres"], multi: false, selectedOptions: ["Postgres"] }] } },
	{ id: "malformed_entry", input: { answers: [{ name: "x" }, db] } },
];

const ASK = "tools/ask.d.ts";
const DATA = "html-form/data.d.ts";
const variants: { id: string; file: string; from: string; to: string }[] = [
	{ id: "rename_optional_timedOut", file: ASK, from: "    timedOut?: boolean;", to: "    timeout?: boolean;" },
	{ id: "add_optional_top", file: ASK, from: "    timedOut?: boolean;", to: "    timedOut?: boolean;\n    attachments?: string[];" },
	{ id: "add_optional_FormAnswer", file: DATA, from: "    answer: string;\n}", to: "    answer: string;\n    hint?: string;\n}" },
	{ id: "add_optional_OptionNote", file: DATA, from: "    text: string;\n}", to: "    text: string;\n    label?: string;\n}" },
	{ id: "rename_FormAnswer_answer", file: DATA, from: "    answer: string;\n}", to: "    text: string;\n}" },
	{ id: "remove_notes", file: ASK, from: "    notes?: OptionNote[];\n", to: "" },
	{ id: "notes_required", file: ASK, from: "    notes?: OptionNote[];", to: "    notes: OptionNote[];" },
	{ id: "remove_OptionNote_value", file: DATA, from: "    value: string;\n    text: string;\n}", to: "    text: string;\n}" },
];

const sh = (cmd: string[], cwd?: string) => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
};
const render = (mod: any, msg: unknown) => {
	try {
		const answers = mod.askAnswers(msg);
		return answers === null ? null : mod.formatAskAnswers(answers);
	} catch (error) {
		return `THROW ${error instanceof Error ? error.message : String(error)}`;
	}
};
const stage = (label: string, repo: string, sha: string) => {
	const dir = `${SCRATCH}/${label}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/ask-answers.ts`, sh(["git", "-C", repo, "show", `${sha}:${MODULE}`]).out);
	if (!existsSync(`${dir}/node_modules`)) symlinkSync(`${BASE}/node_modules`, `${dir}/node_modules`);
	cpSync(`${BASE}/node_modules/@oh-my-pi/pi-tui/dist/types`, `${dir}/types`, { recursive: true });
	const baseConfig = JSON.parse(readFileSync(`${BASE}/tsconfig.json`, "utf8"));
	writeFileSync(
		`${dir}/tsconfig.json`,
		JSON.stringify({ compilerOptions: { ...baseConfig.compilerOptions, paths: { "@oh-my-pi/pi-tui/*": ["./types/*"], "@oh-my-pi/pi-tui": ["./types/index"] } }, files: ["ask-answers.ts"] }),
	);
	return dir;
};
const tsc = (dir: string) => sh([`${BASE}/node_modules/.bin/tsc`, "-p", `${dir}/tsconfig.json`], dir);

const baseDir = stage("base", BASE, "HEAD");
const baseMod = await import(`${baseDir}/ask-answers.ts`);

const targets = process.argv.slice(2).map((arg) => {
	const [label, rest] = arg.split("=") as [string, string];
	const [repo, sha] = rest.split("@") as [string, string];
	return { label, repo, sha };
});

await Promise.all(
	targets.map(async ({ label, repo, sha }) => {
		const dir = stage(label, repo, sha);
		const mod = await import(`${dir}/ask-answers.ts`);
		const failed: Record<string, unknown> = {};
		const score = { C: [0, 0], I: [0, 0] } as Record<string, [number, number]>;
		for (const item of cases) {
			const got = render(mod, message(item.input, item.over));
			const bucket = score[item.kind] as [number, number];
			bucket[1]++;
			if (got === item.expect) bucket[0]++;
			else failed[item.id] = got;
		}
		for (const item of legacy) {
			const got = render(mod, message(item.input));
			const want = render(baseMod, message(item.input));
			const bucket = score.C as [number, number];
			bucket[1]++;
			if (got === want) bucket[0]++;
			else failed[item.id] = { got, want };
		}
		const observed = Object.fromEntries(recorded.map((item) => [item.id, render(mod, message(item.input))]));
		const control = tsc(dir);
		const link: Record<string, string> = {};
		let detected = 0;
		if (control.code !== 0) link.control = `FAILS: ${control.out.slice(0, 300)}`;
		else
			for (const variant of variants) {
				const path = `${dir}/types/${variant.file}`;
				const pristine = readFileSync(path, "utf8");
				if (!pristine.includes(variant.from)) {
					link[variant.id] = "variant text not found";
					continue;
				}
				writeFileSync(path, pristine.replace(variant.from, variant.to));
				const run = tsc(dir);
				writeFileSync(path, pristine);
				if (run.code !== 0) detected++;
				else link[variant.id] = "MISSED (tsc exit 0)";
			}
		console.log(JSON.stringify({ label, sha, contract: score.C, wording: score.I, typeLink: [detected, variants.length], failed, link, observed }));
	}),
);
