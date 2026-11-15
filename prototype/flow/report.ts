// The store's verdict in words: what a state holds and what changed since the caller last saw it.
// It reports what the store concluded, never the values that were written into it.
import { stableText } from "./defs.ts";
import type { Survey } from "./plan.ts";
import { type Item, markOf, type State } from "./state.ts";

/** One line per box, input and item; two states differ exactly where their marks differ. */
export type Marks = Readonly<Record<string, string>>;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** The start of a reason; the item's own line carries all of it. */
const brief = (text: string): string => {
	const line = oneLine(text);
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

function itemLabel(state: State, survey: Survey, item: Item): string {
	const box = state.boxes[item.box];
	const suffix = !box
		? " · illegal: its box is no longer defined"
		: survey.stale.includes(item.key)
			? ` · stale: produced under definition ${item.fingerprint}, now ${markOf(state, box)}`
			: "";
	const phase = item.phase;
	switch (phase.kind) {
		case "running":
			return `running, session ${item.attempt}${item.session === undefined ? "" : ` (history://${item.session})`}${suffix}`;
		case "done":
			return `done in session ${item.attempt}${suffix}`;
		case "raised": {
			const raise = survey.raised.find((entry) => entry.key === item.key);
			const answer =
				raise === undefined ? "answered" : raise.handler === undefined ? "nothing answers it" : `waits for \`${raise.handler}\``;
			return `raised \`${phase.type}\` (${answer}): ${oneLine(phase.detail)}${suffix}`;
		}
		case "failed":
			return `failed with \`${phase.name}\` in session ${item.attempt}: ${oneLine(phase.reason)}${suffix}`;
		case "retry":
			return `fires again after \`${phase.name}\` in session ${item.attempt}: ${oneLine(phase.reason)}${suffix}`;
		case "cancelled":
			return `cancelled in session ${item.attempt}${suffix}`;
		default: {
			const unreachable: never = phase;
			return unreachable;
		}
	}
}

export function marksOf(state: State, survey: Survey): Marks {
	const marks: Record<string, string> = {};
	for (const [name, box] of Object.entries(state.boxes)) marks[`box ${name}`] = `definition ${markOf(state, box)}`;
	for (const [name, value] of Object.entries(state.inputs))
		marks[`input.${name}`] = `supplied (${stableText(value).length} characters of JSON)`;
	for (const item of Object.values(state.items)) marks[item.key] = itemLabel(state, survey, item);
	return marks;
}

const ordered = (keys: Iterable<string>): string[] => [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/** What differs between two sets of marks, one line each. */
export function delta(before: Marks, after: Marks): string[] {
	const lines: string[] = [];
	for (const key of ordered(new Set([...Object.keys(before), ...Object.keys(after)]))) {
		const was = before[key];
		const is = after[key];
		if (was === is) continue;
		if (is === undefined) lines.push(`- ${key}: removed`);
		else if (was === undefined) lines.push(`+ ${key}: ${is}`);
		else lines.push(`~ ${key}: ${is}`);
	}
	return lines;
}

/** Where the flow stands and what, if anything, keeps it from going on. */
export function headline(state: State, survey: Survey): string[] {
	const count = (kind: Item["phase"]["kind"]): number => Object.values(state.items).filter((item) => item.phase.kind === kind).length;
	const counts = [
		`${count("done")} done`,
		`${count("running")} running`,
		`${count("raised")} raised`,
		`${count("failed")} failed`,
		`${count("cancelled")} cancelled`,
	].join(" · ");
	const lines: string[] = [];
	switch (state.mode.kind) {
		case "running":
			lines.push(`flow running · ${counts}`);
			break;
		case "idle": {
			const complete =
				Object.keys(state.boxes).length > 0 &&
				survey.waiting.length === 0 &&
				survey.ready.length === 0 &&
				Object.values(state.items).every((item) => item.phase.kind === "done");
			lines.push(`flow ${complete ? "complete" : "not running"} · ${counts}`);
			break;
		}
		case "stopped": {
			const cause = state.mode.cause;
			const why =
				cause.kind === "exception"
					? `\`${cause.key}\` failed with \`${cause.name}\`, which its box does not handle: ${brief(cause.reason)}`
					: `stopped by the caller: ${brief(cause.reason)}`;
			lines.push(`flow STOPPED · ${counts}`, `cause: ${why}`);
			break;
		}
		default: {
			const unreachable: never = state.mode;
			return unreachable;
		}
	}
	for (const problem of survey.problems) lines.push(`problem: ${problem}`);
	if (survey.needs.length > 0) lines.push(`needs: ${survey.needs.map((name) => `input.${name}`).join(", ")}`);
	if (survey.waiting.length > 0) lines.push(`waiting for inputs: ${survey.waiting.join(", ")}`);
	if (survey.stale.length > 0) lines.push(`stale: ${survey.stale.join(", ")}`);
	if (survey.illegal.length > 0) lines.push(`illegal: ${survey.illegal.join(", ")}`);
	const unanswered = survey.raised.filter((raise) => raise.handler === undefined).map((raise) => raise.key);
	if (unanswered.length > 0) lines.push(`raised and unanswered: ${unanswered.join(", ")}`);
	return lines;
}
