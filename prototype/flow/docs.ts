import * as path from "node:path";

export const DESCRIPTION = `Runs a flow of boxes (fresh subagent sessions and shell commands, wired to each other by name) from one append-only store, and answers every call with the store's verdict. Use it to split work into many small sessions whose results feed later ones. Call it from \`eval\` cells to hand values computed in code (a \`gh\` result, a parsed file) to the flow without retyping them.

Topics — read the one a call needs before making it:
- \`tool://flow/boxes\` — before writing or changing box definitions
- \`tool://flow/lifecycle\` — before \`run\`, or after a verdict that says STOPPED, stale, illegal, raised or refused
- \`tool://flow/eval\` — before calling the tool from an eval cell`;

const BOXES = `# Box definitions

\`define\` takes one JSON object mapping box names to boxes. Boxes it does not mention keep their definition; \`null\` drops a box. A call with any problem is refused whole and lists every problem.

An agent box runs one fresh subagent session per item:

\`\`\`json
{
  "agent": "task:low",
  "brief": "List the files this issue touches.\\n\\n{{issue}}",
  "in": { "issue": "input.issue" },
  "out": { "type": "object", "required": ["files"], "properties": { "files": { "type": "array", "items": { "type": "string" } } } },
  "raises": ["question"],
  "handle": { "session": 1 },
  "limit": 2,
  "bound": 3,
  "isolated": true
}
\`\`\`

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
| \`checks\` | command | Name of an agent box whose result this command checks (see Checks). |
| \`isolated\` | agent | \`true\`: each session runs in its own worktree, and a later session of the same item starts from the changes an earlier one left without handing them back. \`false\`: the sessions share your workspace on purpose, for boxes that only read or compute. Absent: the host's default for the agent. |
| \`prepare\` | agent | A command run in the session's workspace before its first turn, for what the session needs and no model should spend a turn on (\`bun install\`). \`{{name}}\` is replaced by the input's text as one quoted shell word. When it fails, the session does not start. |

## References

| Reference | Value |
|---|---|
| \`input.issue\` | A value given with \`supply\`. |
| \`scout\` | The result of box \`scout\`: one value, or the array of its items' results when \`scout\` has many items. |
| \`scout.files\` | A field of that result; more names go deeper. |
| \`scout.files[]\` | One item of this box per element of that array. Items are named \`box#0\`, \`box#1\`, … |
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
| 1–125 | The check rejects. The item it checks is reopened: it continues in a new session that is given the earlier session's handoff and the command's output, and everything computed from its earlier result, this check included, is removed and produced again from the new result. The flow goes on; no exception is raised. |
| 126 and above | The command could not run or was killed. This is the \`exit\` exception, as for any command box; nothing is reopened. |

Each reopening is one of the checked box's \`bound\` sessions. A rejection of the result of an item's last allowed session raises \`bound_exceeded\`.

The command box must take an input from the box it checks. When that box has many items, take \`work[]\`: item \`check#2\` then checks \`work#2\`.

## Sessions

Every session is new: none continues an earlier one. A session ends by yielding its result or one of its box's \`raises\` types, and a handoff with it. What a later session of the same item has of an earlier one:

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
| \`protocol\` | The yielded object is not a result or a declared raise. |
| \`bound_exceeded\` | An item raised in its last allowed session, or a check rejected the result of an item's last allowed session. |
| \`exit\` | A command exited non-zero; for a check, with 126 or above. |
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
| \`value\` | The stored value of each key: \`input.<name>\`, an item, or a box (the array of its items' results). |
| \`retract\` | Removes items or inputs and everything computed from them; they are produced again. |
| \`keep\` | Declares a stale item's value still good under the current definition. |
| \`retry\` | Lets a failed item fire again unchanged. |
| \`answer\` | Answers an item's raise from outside the flow; the item continues in a new session. |

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

An item that raised waits for its answer while the rest of the flow goes on. The answer is the result of the box that takes \`<box>!<type>\` as an input, or the value of an \`answer\` call when no box does. A flow that comes to rest with a raise nobody answers reports it as \`raised and unanswered\`; \`answer\` it and \`run\` again.`;

export function flowTopics(): Readonly<Record<string, string>> {
	const helper = path.join(import.meta.dir, "helper.js");
	return {
		boxes: BOXES,
		lifecycle: LIFECYCLE,
		eval: `# Calling the flow from an eval cell

In a JavaScript cell the tool is \`tool.flow\`. Definitions and values travel as JSON text:

\`\`\`js
const issue = JSON.parse(await sh\`gh issue view 12 --json title,body\`);
const r = await tool.flow({ op: "supply", name: "issue", value: JSON.stringify(issue) });
print(r.text);
\`\`\`

The call resolves to \`{text, details}\`: \`text\` is the verdict, \`details.accepted\` says whether the call was applied, and \`details.values\` holds the values of a \`value\` call by key. A refused call resolves with \`hasError: true\`; it does not throw. Nothing reaches the transcript unless the cell prints it.

The helper wraps this. Load it once per kernel:

\`\`\`
%load ${helper}
\`\`\`

It defines \`flow\`, whose functions take JavaScript values, print the verdict when the call returns, and throw when the call is refused:

\`\`\`js
await flow.define({ scout: { agent: "task:low", brief: "…{{issue}}", in: { issue: "input.issue" }, out: { type: "object" } } });
await flow.supply("issue", issue);
await flow.run();
const { files } = await flow.value("scout");
\`\`\`

| Function | Returns |
|---|---|
| \`flow.define(boxes)\`, \`flow.supply(name, value)\`, \`flow.run()\`, \`flow.stop(reason)\`, \`flow.status()\` | nothing; the verdict is printed |
| \`flow.retract(...keys)\`, \`flow.keep(...keys)\`, \`flow.retry(...keys)\`, \`flow.answer(key, value)\` | nothing; the verdict is printed |
| \`flow.value(key)\` | the stored value of that key; prints nothing |

The helper holds no state. After a kernel restart the flow is unchanged: load the helper again, or call \`tool.flow\` directly.`,
	};
}
