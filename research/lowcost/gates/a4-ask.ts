import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = process.env.SRC!;
const fromCheckout = (specifier: string) => pathToFileURL(Bun.resolveSync(specifier, SRC)).href;
const { parseHtmlForm } = await import(fromCheckout("@oh-my-pi/pi-tui/html-form/parse"));
const { formAnswers } = await import(fromCheckout("@oh-my-pi/pi-tui/html-form/data"));
const { askAnswers, formatAskAnswers } = await import(
	pathToFileURL(join(SRC, "agent", "extensions", "_shared", "ask-answers.ts")).href
);
const { createTranscriptReader } = await import(
	pathToFileURL(join(SRC, "agent", "extensions", "user-prompt-inject", "transcript.ts")).href
);

const lineOf = (details: unknown, extra: Record<string, unknown> = {}) => {
	const answers = askAnswers({ toolName: "ask", isError: false, details, ...extra });
	return answers === null ? null : formatAskAnswers(answers);
};

const form = parseHtmlForm(`<form>
<fieldset><legend>Database</legend>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="postgres"> Postgres</label>
</fieldset>
<label>Backfill <input type="text" name="ticks" value="no"></label>
</form>`);
const answers = formAnswers(form, { db: "sqlite", ticks: "no" });
const native = { answers };
const nativeLine = answers.map((answer: { question: string; answer: string }) => `${answer.question} → ${answer.answer}`).join("\n");
const noted = {
	answers: answers.filter((answer: { name: string }) => answer.name === "db"),
	notes: [
		{ name: "db", question: "Database", option: "SQLite", value: "sqlite", text: "only if\nbackups stay" },
		{ name: "db", question: "Database", option: "SQLite", value: "sqlite", text: "and WAL on" },
		{ name: "gone", question: "Removed", option: "Other", value: "other", text: "orphan note" },
	],
};

const dir = mkdtempSync(join(tmpdir(), "a4-ask-"));
const records = [
	{ type: "session", id: "s1", cwd: dir },
	{
		type: "message",
		id: "m1",
		parentId: null,
		message: { role: "user", attribution: "user", content: [{ type: "text", text: "which db?" }] },
	},
	{
		type: "message",
		id: "m2",
		parentId: "m1",
		message: { role: "toolResult", toolName: "ask", isError: false, details: native },
	},
	{
		type: "message",
		id: "m3",
		parentId: "m2",
		message: {
			role: "toolResult",
			toolName: "ask",
			isError: false,
			details: { answers: [answers[1]], timedOut: true },
		},
	},
];
const transcript = join(dir, "session.jsonl");
writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
const reader = createTranscriptReader();
const persisted = reader.read(transcript, { prompts: false, answers: true }).answers();
reader.release();

const blankField = formAnswers(form, { db: "sqlite" }).filter((answer: { name: string }) => answer.name === "ticks");

const readings = {
	hostAnswers: answers,
	native: lineOf(native),
	notes: lineOf(noted),
	blankField,
	blankAnswer: lineOf({ answers: blankField }),
	emptyAnswers: lineOf({ answers: [] }),
	timedOut: lineOf({ answers: [answers[1]], timedOut: true }),
	notTimedOut: lineOf({ answers: [answers[1]], timedOut: false }),
	legacyBatch: lineOf({ results: [{ question: "Database", selectedOptions: ["SQLite"], customInput: "in WAL" }] }),
	legacySingle: lineOf({ question: "Database", selectedOptions: ["SQLite"] }),
	legacyNoSelection: lineOf({ question: "Database", selectedOptions: [] }),
	otherTool: lineOf(native, { toolName: "bash" }),
	errorResult: lineOf(native, { isError: true }),
	persisted,
};

console.log(JSON.stringify(readings, null, 2));

const ok =
	answers.length === 2 &&
	answers.every(
		(answer: Record<string, unknown>) =>
			typeof answer.name === "string" && typeof answer.question === "string" && typeof answer.answer === "string",
	) &&
	readings.native === nativeLine &&
	readings.notes === `${nativeLine.split("\n")[0]} [note: SQLite — only if backups stay] [note: SQLite — and WAL on]` &&
	blankField.length === 1 &&
	blankField[0].answer === "" &&
	readings.blankAnswer === null &&
	readings.emptyAnswers === null &&
	readings.timedOut === null &&
	readings.notTimedOut === "Backfill → no" &&
	readings.legacyBatch === 'Database → SQLite + "in WAL"' &&
	readings.legacySingle === "Database → SQLite" &&
	readings.legacyNoSelection === null &&
	readings.otherTool === null &&
	readings.errorResult === null &&
	readings.persisted.length === 1 &&
	readings.persisted[0] === nativeLine;
if (!ok) {
	console.error("A4 expectation failed");
	process.exit(1);
}
