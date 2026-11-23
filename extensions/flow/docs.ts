import { registerToolTopics, type ToolTopicDoc, toDocTopics } from "../../omomp-shared/internal-url.ts";

export const DESCRIPTION = `Runs a flow of boxes (fresh subagent sessions and shell commands, wired to each other by name) from one append-only store, and answers every call with the store's verdict. Use it to split work into many small sessions whose results feed later ones. Call it from \`eval\` cells to hand values computed in code (a \`gh\` result, a parsed file) to the flow without retyping them.

Topics — read the one a call needs before making it:
- \`help://flow/boxes\` — before writing or changing box definitions
- \`help://flow/lifecycle\` — before \`run\`, before answering a split request, or after a verdict that says STOPPED, stale, illegal, raised or refused
- \`help://flow/eval\` — before calling the tool from an eval cell`;

const BOXES = `# Box definitions

\`define\` takes one JSON object mapping box names to boxes. Boxes it does not mention keep their definition; \`null\` drops a box. A call with any problem is refused whole and lists every problem.

An agent box runs one fresh subagent session per item:

\`\`\`json
{
  "agent": "flow:worker",
  "model": "task:low",
  "brief": "Implement this slice.\\n\\n{{slice}}",
  "in": { "slice": "scout.slices[]" },
  "out": { "type": "object", "required": ["files"], "properties": { "files": { "type": "array", "items": { "type": "string" } } } },
  "raises": ["question"],
  "handle": { "session": 1 },
  "limit": 2,
  "bound": 3,
  "isolated": true,
  "prepare": "bun install"
}
\`\`\`

The plugin ships one agent per role a flow usually needs. Each has its own system prompt and no model of its own: name the tier whose model setting it runs on in \`model\`. Rules of the project the flow works in go into the \`brief\`.

| Agent | Role |
|---|---|
| \`flow:scout\` | Read-only. Splits one request into slices, open points and check gaps for later boxes to fan out over. |
| \`flow:worker\` | Implements one slice in its workspace; raises what the assignment leaves open instead of guessing. |
| \`flow:adjudicator\` | Read-only. Rules on raised points or open points; never implements. |
| \`flow:guardian\` | Read-only. Judges once, at the end, whether what was built is what the request asked for. |
| \`flow:verifier\` | Carries out one acceptance step as written and reports what it observed; never repairs. |

A command box runs one shell command per item, in POSIX syntax. Its result is the command's output text:

\`\`\`json
{ "command": "printf %s {{files}} | wc -c", "in": { "files": "scout.files" }, "handle": { "exit": 1 } }
\`\`\`

| Field | Box | Meaning |
|---|---|---|
| \`agent\` | agent | Name of the agent definition the sessions run as: its system prompt and tools. |
| \`model\` | agent | Name of an agent whose model setting the sessions use instead of \`agent\`'s own, for example \`"task:low"\`: your override for that agent, else the model in its definition. |
| \`brief\` | agent | The assignment. \`{{name}}\` is replaced by the input's text: a string as it is, anything else as JSON. |
| \`command\` | command | The command line. \`{{name}}\` is replaced by the input's text as one quoted shell word. |
| \`in\` | both | Input name → reference (below). |
| \`out\` | agent | JSON Schema of the result. |
| \`raises\` | agent | Exception types a session may raise instead of returning a result. |
| \`handle\` | both | Runtime exception name → how many times the item fires again before that exception stops the flow. |
| \`limit\` | both | Most items of the box in flight at once. Unlimited when absent. |
| \`bound\` | agent | Most sessions one item may take through answered raises and rejections by a check: the first, and one per answer or rejection. 3 when absent. |
| \`splits\` | agent | How many levels deep one element may be split (see Splitting): \`1\` lets an item split, its parts not. Needs a \`[]\` input and \`isolated: true\`. Absent: no session may split. |
| \`checks\` | command | Name of an agent box whose result this command checks (see Checks). |
| \`rejects\` | command | With \`checks\`: the exit codes that reject the checked result, \`[1]\` when absent. Name every code the check uses for a rejection, for example \`[1, 2]\` for \`tsc\`. |
| \`isolated\` | agent | \`true\`: each session runs in its own worktree, and a later session of the same item starts from the changes an earlier one left without handing them back. \`false\`: the sessions share your workspace on purpose, for boxes that only read or compute. Absent: the host's default for the agent. |
| \`prepare\` | agent | A command run in the session's workspace before its first turn, for what the session needs and no model should spend a turn on (\`bun install\`). \`{{name}}\` is replaced by the input's text as one quoted shell word. When it fails, the session does not start. |

## References

| Reference | Value |
|---|---|
| \`input.issue\` | A value given with \`supply\`. |
| \`scout\` | The result of box \`scout\`: one value, or the array of its items' results when \`scout\` has many items (of its leaves' results when items split). |
| \`scout.files\` | A field of that result; more names go deeper. |
| \`scout.files[]\` | One item of this box per element of that array. Items are named \`box#0\`, \`box#1\`, …; the parts of a split item add their index, \`box#0.1\`. |
| \`work!question\` | One item of this box per item of \`work\` that raised \`question\`. The input is \`{item, type, detail, handoff, board}\`; \`board\` is the path of the raising item's notes file. This box's result is the answer, and the raising item continues in a new session that is given the answer. |

A box takes at most one reference of the last two kinds. References are resolved by name when the flow runs, so boxes may be defined in any order and redefined one at a time.

## Checks

A command box that names an agent box in \`checks\` is a check of that box's work. It is part of the flow's wiring: the way back from a result to the work that produced it.

\`\`\`json
{ "command": "bun test", "in": { "work": "work[]" }, "checks": "work" }
\`\`\`

The command's exit code is its verdict:

| Exit code | Meaning |
|---|---|
| 0 | The check accepts. The output is the box's result. |
| One of \`rejects\` | The check rejects. The item it checks is reopened: it continues in a new session that is given the earlier session's handoff and the command's output, and everything computed from its earlier result, this check included, is removed and produced again from the new result. The flow goes on; no exception is raised. |
| Any other | The check itself went wrong: a missing program, a syntax error, a kill. This is the \`exit\` exception, as for any command box; nothing is reopened. |

Each reopening is one of the checked box's \`bound\` sessions. A rejection of the result of an item's last allowed session raises \`bound_exceeded\`.

The command box must take an input from the box it checks. When that box has many items, take \`work[]\`: item \`check#2\` then checks \`work#2\`, and \`check#0.1\` checks the part \`work#0.1\`.

## Splitting

A session of a box with \`splits\` that finds its element too large for one session asks you, the author of the flow, for a split: it calls its \`flow_split\` tool with the parts and the details you need to judge them, and that call blocks until you answer (see \`help://flow/lifecycle\`). When you disagree, the session gets your reason and goes on. When you agree, it yields \`{"status": "split", …}\` instead of a result, and the item has no result of its own. Each part takes the place of the element as an item of the same box, named by appending its index (\`work#0\` splits into \`work#0.0\`, \`work#0.1\`). A part's first session is a fork of the splitting session: it keeps that session's conversation, starts in its own worktree from the changes the splitting session handed back, and is told which part is its own. A part may split again while \`splits\` allows (\`work#0.1.0\`).

Nothing joins the parts. Whatever reads \`work\` reads its leaves, the items that ended with a result, in key order: \`work[]\` makes one item per leaf with the same path, and \`work\` is the array of the leaves' results, so a box that reduces them is an ordinary box taking \`work\`. Each leaf is checked, reopened and retracted on its own; retracting the split item removes its parts and what was computed from them, and the item fires again whole.

## Sessions

Every session but a part's first is new: it continues no earlier one. A session ends by yielding its result, one of its box's \`raises\` types or a split you agreed to, and a handoff with it. What a later session of the same item has of an earlier one:

- the handoff the earlier session yielded, when it raised and the raise was answered, or when a check reopened the item;
- the item's notes file, which every session of the item is told to read and append to and no other item is told about; it is removed when the item is retracted;
- for an \`isolated\` box, the changes the earlier session left in its worktree. A session that yields hands its changes to your checkout, where the next worktree starts from them; when \`task.isolation.apply\` is off they stay a patch, which the next session of the item receives. A session that failed or was cancelled hands nothing back, and the next session of the item starts with its uncommitted changes applied, whatever model it runs on. The same holds for a session that yielded and whose changes could not be merged: the item fails with \`workspace\`, and its next session starts from those changes.

A worktree holds no ignored files of your checkout (installed dependencies, build output): give the box a \`prepare\` command for what its sessions need. Everything a session or its \`prepare\` command leaves in the worktree that git does not ignore is handed back as the session's change.

## Runtime exceptions

| Name | Raised when |
|---|---|
| \`spawn\` | The session could not be started. |
| \`workspace\` | The changes an earlier session of the item left cannot be carried into the new session, or a session yielded and OMP reported that its changes did not reach your checkout (the reason quotes OMP). |
| \`session\` | The session failed, aborted itself, or ended without yielding; or its \`prepare\` command failed. |
| \`schema\` | The yielded result does not match \`out\`. |
| \`protocol\` | The yielded object is not a result, a declared raise or a split you agreed to within what \`splits\` allows. |
| \`bound_exceeded\` | An item raised in its last allowed session, or a check rejected the result of an item's last allowed session. |
| \`exit\` | A command exited non-zero; for a check, with a code not in its \`rejects\`. |
| \`timeout\` | A command timed out. |
| \`host\` | Starting or reading the session threw. |`;

const LIFECYCLE = `# Running, stopping and resuming a flow

One flow belongs to one session. Its state is an append-only log of actions kept with the session's files; it survives a restart of OMP and of the eval kernel.

## Operations

| \`op\` | Effect |
|---|---|
| \`define\` | Adds, replaces or drops boxes. |
| \`supply\` | Gives an outside input its value. Supplying a different value removes every result computed from the old one. |
| \`run\` | Starts the flow, or resumes a stopped one. Returns at once; the flow goes on in the background as one job, and its verdict is delivered to you when the flow stops or comes to rest. With nothing else to do, end your turn: the \`wait\` tool returns for every single session of the flow, not for the flow. |
| \`stop\` | Stops a running flow and cancels its sessions. |
| \`status\` | The whole state: every box, input and item. |
| \`value\` | The stored value of each key: \`input.<name>\`, an item, or a box (the array of its items' results; for a box whose items split, of its leaves'). |
| \`retract\` | Removes items or inputs and everything computed from them, the parts of a split item included; they are produced again. |
| \`keep\` | Declares a stale item's value still good under the current definition. |
| \`retry\` | Lets a failed item fire again unchanged. |
| \`answer\` | Answers an item's raise from outside the flow; the item continues in a new session. |
| \`agree\` | Approves the split a running session asks for; the session yields it, and each part runs as a fork of it. |
| \`disagree\` | Refuses that split, with a \`reason\`; the session gets the reason and goes on. |

## Verdicts

Every call answers with the store's verdict: one headline (\`flow running\`, \`flow complete\`, \`flow not running\`, \`flow STOPPED\`), what holds the flow back (\`problem\`, \`needs\`, \`stale\`, \`illegal\`, \`raised and unanswered\`), a \`next:\` line with the operations open to you now, and one line per box, input or item that changed since the previous verdict (\`+\` new, \`~\` changed, \`-\` removed). \`status\` adds one \`wire\` line per box: where its inputs come from, who answers what it raises, and which exceptions make it fire again. A refused call changes nothing; its reasons come first, each prefixed \`refused:\`.

## When the flow stops

A runtime exception that its box does not \`handle\` stops the whole flow: nothing new starts and the sessions still running are cancelled. \`run\` is refused until every failed item is dealt with, in one of three ways:

- \`define\` the item's box again with what needs to change (another agent, another brief, a \`handle\` entry);
- \`retract\` the item;
- \`retry\` the item, when nothing needs to change.

Cancelled items fire again on \`run\` without further action.

## Stale and illegal values

An item records what it ran under: its box, the definition of the box's \`agent\`, and the model setting its sessions used. When any of them changes, results produced under the earlier one are \`stale\`: rebinding a tier's model makes every result produced under that tier stale. When a box is dropped, its items are \`illegal\`. \`run\` is refused while there are any. For each stale item, \`keep\` it or \`retract\` it; for each illegal one, \`retract\` it or define the box again.

## Raises

An item that raised waits for its answer while the rest of the flow goes on. The answer is the result of the box that takes \`<box>!<type>\` as an input, or the value of an \`answer\` call when no box does. A flow that comes to rest with a raise nobody answers reports it as \`raised and unanswered\`; \`answer\` it and \`run\` again.

## Split requests

A running session of a box with \`splits\` may ask to split its element. The request reaches you as a message that names the item, quotes the session's details and lists the parts; while it waits, \`status\` lists it as \`split asked\`. The session is blocked until you call \`agree\` or \`disagree\` with the item's key, so answer it rather than end your turn on it. Each part is a value of the box's fanned input: check that the parts together cover the element and that each can be done and checked on its own.`;

const EVAL = `# Calling the flow from an eval cell

In a JavaScript cell the tool is \`tool.flow\`. Definitions and values travel as JSON text:

\`\`\`js
const issue = JSON.parse(await sh\`gh issue view 12 --json title,body\`);
const r = await tool.flow({ op: "supply", name: "issue", value: JSON.stringify(issue) });
print(r.text);
\`\`\`

The call resolves to \`{text, details}\`: \`text\` is the verdict, \`details.accepted\` says whether the call was applied, and \`details.values\` holds the values of a \`value\` call by key. A refused call resolves with \`hasError: true\`; it does not throw. Nothing reaches the transcript unless the cell prints it.

The skill's helper wraps this. Load it once per kernel, in a cell of its own:

\`\`\`
%load skill://omp-subagent-ng/flow.js
\`\`\`

It defines \`flow\`, whose functions take JavaScript values, print the verdict when the call returns, and throw when the call is refused:

\`\`\`js
await flow.define({ scout: { agent: "flow:scout", model: "task:low", brief: "…{{issue}}", in: { issue: "input.issue" }, out: { type: "object" } } });
await flow.supply("issue", issue);
await flow.run();
const { slices } = await flow.value("scout");
\`\`\`

| Function | Returns |
|---|---|
| \`flow.define(boxes)\`, \`flow.supply(name, value)\`, \`flow.run()\`, \`flow.stop(reason)\`, \`flow.status()\` | nothing; the verdict is printed |
| \`flow.retract(...keys)\`, \`flow.keep(...keys)\`, \`flow.retry(...keys)\`, \`flow.answer(key, value)\`, \`flow.agree(key)\`, \`flow.disagree(key, reason)\` | nothing; the verdict is printed |
| \`flow.value(key)\` | the stored value of that key; prints nothing |

The helper holds no state. After a kernel restart the flow is unchanged: load the helper again, or call \`tool.flow\` directly.`;

const FLOW_TOPICS: readonly ToolTopicDoc[] = [
	{ tool: "flow", topic: "boxes", title: "Box definitions", when: "before writing or changing box definitions", body: BOXES },
	{
		tool: "flow",
		topic: "lifecycle",
		title: "Running, stopping and resuming a flow",
		when: "before `run`, before answering a split request, or after a verdict that says STOPPED, stale, illegal, raised or refused",
		body: LIFECYCLE,
	},
	{
		tool: "flow",
		topic: "eval",
		title: "Calling the flow from an eval cell",
		when: "before calling the tool from an eval cell",
		body: EVAL,
	},
];

export const flowTopics: () => Readonly<Record<string, string>> = toDocTopics(FLOW_TOPICS);

export function registerFlowTopics(): void {
	registerToolTopics("omp-subagent-ng/flow", FLOW_TOPICS);
}
