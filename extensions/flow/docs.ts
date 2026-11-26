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
| \`raises\` | agent | Exception types a session may raise instead of returning a result. A session is offered a type only while its item has sessions left under \`bound\`, and under \`noEscape\` only while some box answers it. |
| \`handle\` | both | Runtime exception name → how many times the item fires again before that exception stops the flow. Under \`noEscape\`, a \`session\`, \`timeout\`, \`protocol\` or \`schema\` failure it does not name fires the item once more (see \`help://flow/lifecycle\`). |
| \`limit\` | both | Most items of the box in flight at once. Unlimited when absent. |
| \`bound\` | agent | Most sessions one item may take through answered raises and rejections by a check: the first, and one per answer or rejection. 3 when absent. |
| \`splits\` | agent | How many levels deep one element may be split (see Splitting): \`1\` lets an item split, its parts not. Needs exactly one \`[]\` input and \`isolated: true\`: a part takes the place of one element, not of a pair. Absent: no session may split. |
| \`checks\` | both | Name of an agent box, or a non-empty array of box names, whose results this box checks (see Checks). Repeats collapse. |
| \`rejects\` | command | With \`checks\`: the exit codes that reject a checked result, \`[1]\` when absent. Name every code the check uses for a rejection, for example \`[1, 2]\` for \`tsc\`. An agent box has no \`rejects\`: it rejects through its yield. |
| \`isolated\` | agent | \`true\`: each session runs in its own worktree, and a later session of the same item starts from the changes an earlier one left without handing them back. \`false\`: the sessions share your workspace on purpose, for boxes that only read or compute. Absent: the host's default for the agent. |
| \`prepare\` | agent | A command run in the session's workspace before its first turn, for what the session needs and no model should spend a turn on (\`bun install\`). \`{{name}}\` is replaced by the input's text as one quoted shell word. When it fails, the session does not start. |

## References

| Reference | Value |
|---|---|
| \`input.issue\` | A value given with \`supply\`. |
| \`scout\` | The result of box \`scout\`: one value, or the array of its items' results when \`scout\` has many items (of its leaves' results when items split). |
| \`scout.files\` | A field of that result; more names go deeper. |
| \`scout.files[]\` | One item of this box per element of that array, paired with the other \`[]\` inputs by leaf path. Items are named \`box#0\`, \`box#1\`, …; the parts of a split item add their index, \`box#0.1\`. |
| \`work!question\` | One item of this box per item of \`work\` that raised \`question\`. The input is \`{item, type, detail, handoff, board}\`; \`board\` is the path of the raising item's notes file. This box's result is the answer, and the raising item continues in a new session that is given the answer. |

A box may take several \`[]\` inputs. It makes one item per path that every \`[]\` input reaches, and the inputs pair by leaf path: item \`review#0\` takes the element at path \`0\` of every \`[]\` input, item \`review#2\` the elements at path \`2\`; when an upstream item split, the path continues with the part index (\`a#0.1\`, then \`review#0.1\`). A path that only some \`[]\` inputs reach is unpaired: no item is made for it, the verdict names it (\`unpaired: review#2 (nothing at this path from a)\`), and the flow does not become \`complete\`. A raise port is still the only one of its kind on a box and cannot sit beside a \`[]\` input. A box with \`splits\` takes exactly one \`[]\` input. References are resolved by name when the flow runs, so boxes may be defined in any order and redefined one at a time.

## Checks

A box that names an agent box in \`checks\` is a check of that box's work. The checking box may be a command box or an agent box; it is part of the flow's wiring: the way back from a result to the work that produced it.

\`\`\`json
{ "command": "bun test", "in": { "work": "work[]" }, "checks": "work" }
\`\`\`

An agent check yields its verdict instead of a result:

\`\`\`json
{"status": "done", "value": {…}, "handoff": {…}}
{"status": "reject", "feedback": "what is wrong and what must change", "handoff": {…}}
\`\`\`

\`done\` accepts, and the check's own result is its \`value\`. \`reject\` rejects; a \`reject\` without non-empty \`feedback\`, or from a box without \`checks\`, fails the session with \`protocol\`.

A command check's exit code is its verdict:

| Exit code | Meaning |
|---|---|
| 0 | The check accepts. The output is the box's result. |
| One of \`rejects\` | The check rejects. |
| Any other | The check itself went wrong: a missing program, a syntax error, a kill. This is the \`exit\` exception, as for any command box; nothing is reopened. |

A rejection reopens every checked item at the check's path at once. Each continues in a new session given its own earlier handoff, the check's output or \`feedback\`, and the values the check was given in that round: for a check that zips \`a[]\` and \`b[]\`, both items' results. Everything computed from the reopened items, this check included, is removed and produced again. The flow goes on; no exception is raised.

Each reopening is one of the checked box's \`bound\` sessions. When any checked item is in its last allowed session (its chain has reached its box's \`bound\`), nothing is reopened and the check fails with \`bound_exceeded\`.

Every box named in \`checks\` must be an agent box that answers no raise. The check must take its input from it, directly or through boxes in between; when the checked box has many items, the check must take \`<box>[]\` of it, or of a box that takes \`<box>[]\` of it along boxes that do not split, and then the check itself may not split: the paths of its parts name no item of the checked box. Item \`check#2\` checks \`work#2\`, and \`check#0.1\` checks the leaf \`work#0.1\`.

## Ruling what a session raises

A worker that raises \`question\` is answered inside the flow: a box that takes \`in: { "raised": "work!question" }\` rules on it, and the worker continues in a new session given that ruling. The ruling box — \`flow:adjudicator\` ships for it — reads the code facts, the request the work serves and the worker's handoff and notes, and yields \`done\` with a complete, directly usable answer. No person is asked.

The ruling box may instead tell the worker what to probe next. The worker raises again with what it found, and the ruling box rules again, until the point is decided or the worker's \`bound\` sessions run out.

A product, scope or trade-off question that neither the code facts nor the request decide does not belong to the ruling box alone. It may declare a raise of its own, such as \`ask_user\`, that no box answers, and yield it: \`{"status": "raise", "raise": "ask_user", "detail": "…", "handoff": {…}}\`. The flow then rests at the ruling item until you call \`answer\`; a new session turns your answer into a complete engineering instruction and yields \`done\`, and the worker continues with it. This is the only way a ruling box reaches you: it never uses the \`ask\` tool and never starts subagents. Under \`noEscape\` its outward raise is not offered, so it must decide.

## Splitting

A session of a box with \`splits\` that finds its element too large for one session asks you, the author of the flow, for a split: it calls its \`flow_split\` tool with the parts and the details you need to judge them, and that call blocks until you answer (see \`help://flow/lifecycle\`). When you disagree, the session gets your reason and goes on. When you agree, it yields \`{"status": "split", …}\` instead of a result, and the item has no result of its own. Each part takes the place of the element as an item of the same box, named by appending its index (\`work#0\` splits into \`work#0.0\`, \`work#0.1\`). A part's first session is a fork of the splitting session: it keeps that session's conversation, starts in its own worktree from the changes the splitting session handed back, and is told which part is its own. A part may split again while \`splits\` allows (\`work#0.1\`). Under \`noEscape\` a request that passes its checks is approved at once without asking you; an invalid one is still refused with the reason.

Nothing joins the parts. Whatever reads \`work\` reads its leaves, the items that ended with a result, in key order: \`work[]\` makes one item per leaf with the same path, and \`work\` is the array of the leaves' results, so a box that reduces them is an ordinary box taking \`work\`. Each leaf is checked, reopened and retracted on its own; retracting the split item removes its parts and what was computed from them, and the item fires again whole.

## Sessions

Every session but a part's first is new: it continues no earlier one. A session ends by yielding its result, a \`reject\` when its box \`checks\` another, one of the raise types it was offered, or a split you agreed to, and a handoff with it. What a later session of the same item has of an earlier one:

- the handoff the earlier session yielded, when it raised and the raise was answered, or when a check reopened the item, with the check's output and the values the check was given in that round;
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
| \`protocol\` | The yielded object is not a result, a raise the session was offered, a \`reject\` from a box that \`checks\` another with non-empty \`feedback\`, or a split you agreed to within what \`splits\` allows. |
| \`bound_exceeded\` | A check rejected the result of an item's last allowed session. A last session is offered no raise, so a raise from it is \`protocol\`. |
| \`exit\` | A command exited non-zero; for a check, with a code not in its \`rejects\`. |
| \`timeout\` | A command timed out. |
| \`host\` | Starting or reading the session threw. |`;

const LIFECYCLE = `# Running, stopping and resuming a flow

One flow belongs to one session. Its state is an append-only log of actions kept with the session's files; it survives a restart of OMP and of the eval kernel.

## Operations

| \`op\` | Effect |
|---|---|
| \`define\` | Adds, replaces or drops boxes, and takes \`noEscape\` (see noEscape). |
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

\`define\` takes an optional boolean \`noEscape\` beside \`boxes\`: \`true\` turns it on, \`false\` off, omitted leaves it unchanged; a call that only changes it is still applied.

## Verdicts

Every call answers with the store's verdict: one headline (\`flow running\`, \`flow complete\`, \`flow not running\`, \`flow STOPPED\`), what holds the flow back (\`problem\`, \`needs\`, \`waiting for inputs\`, \`unpaired\`, \`stale\`, \`illegal\`, \`raised and unanswered\`), a \`next:\` line with the operations open to you now, and one line per box, input or item that changed since the previous verdict (\`+\` new, \`~\` changed, \`-\` removed). \`status\` adds one \`wire\` line per box: where its inputs come from, who answers what it raises, and which exceptions make it fire again. A \`noEscape: on\` line follows the headline while the mode is on. A refused call changes nothing; its reasons come first, each prefixed \`refused:\`.

## When the flow stops

A runtime exception that its box does not \`handle\` stops the whole flow: nothing new starts and the sessions still running are cancelled. \`run\` is refused until every failed item is dealt with, in one of three ways:

- \`define\` the item's box again with what needs to change (another agent, another brief, a \`handle\` entry);
- \`retract\` the item;
- \`retry\` the item, when nothing needs to change.

Cancelled items fire again on \`run\` without further action.

Under \`noEscape\`, \`session\`, \`timeout\`, \`protocol\` and \`schema\` failures fire the item once more before they stop the flow, unless the box's \`handle\` names them; \`spawn\`, \`workspace\`, \`exit\`, \`host\` and \`bound_exceeded\` get no such retry.

## noEscape

\`noEscape\` is for a flow that runs unattended. While it is on:

- the verdict carries a \`noEscape: on\` line;
- \`run\` is refused until every input a box takes is supplied: \`input.y: not supplied; with noEscape the flow starts only once every input it needs has a value\`;
- a session's result schema and brief offer only the raise types some box of the flow answers; a session offered none has no \`raise\` status, and a raise outside what it was offered fails with \`protocol\`;
- a split request that passes its checks (the box allows a split at this depth, no earlier request of the session is pending or approved, at least two pieces, each JSON text) is approved at once without a message to you, while an invalid one is still refused with the reason.

\`define\` with \`noEscape: false\` turns it off; leaving it out changes nothing.

## Stale and illegal values

An item records what it ran under: its box, the definition of the box's \`agent\`, and the model setting its sessions used. When any of them changes, results produced under the earlier one are \`stale\`: rebinding a tier's model makes every result produced under that tier stale. When a box is dropped, its items are \`illegal\`. \`run\` is refused while there are any. For each stale item, \`keep\` it or \`retract\` it; for each illegal one, \`retract\` it or define the box again.

## Raises

An item that raised waits for its answer while the rest of the flow goes on. The answer is the result of the box that takes \`<box>!<type>\` as an input, or the value of an \`answer\` call when no box does. A flow that comes to rest with a raise nobody answers reports it as \`raised and unanswered\`; \`answer\` it and \`run\` again.

A session is offered the raise types its box declares, except that under \`noEscape\` a type no box answers is not offered, and in an item's last allowed session (its chain of sessions has reached \`bound\`) none at all is offered — with none, the session has no \`raise\` status. A session that raises a type it was not offered fails with \`protocol\`.

## Split requests

A running session of a box with \`splits\` may ask to split its element. The request reaches you as a message that names the item, quotes the session's details and lists the parts; while it waits, \`status\` lists it as \`split asked\`. The session is blocked until you call \`agree\` or \`disagree\` with the item's key, so answer it rather than end your turn on it. Each part is a value of the box's fanned input: check that the parts together cover the element and that each can be done and checked on its own. Under \`noEscape\` a request that passes those checks is approved at once and the session goes on to yield; nothing reaches you, and a request that fails them is still refused with the reason.`;

const EVAL = `# Calling the flow from an eval cell

Subagents started from an eval cell go through the flow. A cell that calls the eval prelude's \`agent()\` or \`workpool()\`, itself or in a script it runs with \`%load\`, is refused before it runs: the prelude's \`wait()\` cancels the subagents it waits on when the cell is interrupted, while \`run\` returns at once and the flow goes on in a background job of its own. Python cells only compute: a Python cell that calls \`tool.flow(...)\`, \`judge\`, \`judge_batch\` or \`completion\` is refused as well, so call the flow from a JavaScript cell.

In a JavaScript cell the tool is \`tool.flow\`. Definitions and values travel as JSON text:

\`\`\`js
const issue = JSON.parse(await sh\`gh issue view 12 --json title,body\`);
const r = await tool.flow({ op: "supply", name: "issue", value: JSON.stringify(issue) });
print(r.text);
\`\`\`

The call resolves to \`{text, details}\`: \`text\` is the verdict, \`details.accepted\` says whether the call was applied, and \`details.values\` holds the values of a \`value\` call by key. A refused call resolves with \`hasError: true\`; it does not throw. Nothing reaches the transcript unless the cell prints it.

\`define\` takes \`noEscape\` beside \`boxes\`:

\`\`\`js
const boxes = { work: { agent: "flow:worker", brief: "…{{issue}}", in: { issue: "input.issue" }, out: { type: "object" } } };
await tool.flow({ op: "define", boxes: JSON.stringify(boxes), noEscape: true });
\`\`\`

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
| \`flow.define(boxes, opts)\`, \`flow.supply(name, value)\`, \`flow.run()\`, \`flow.stop(reason)\`, \`flow.status()\` | nothing; the verdict is printed |
| \`flow.retract(...keys)\`, \`flow.keep(...keys)\`, \`flow.retry(...keys)\`, \`flow.answer(key, value)\`, \`flow.agree(key)\`, \`flow.disagree(key, reason)\` | nothing; the verdict is printed |
| \`flow.value(key)\` | the stored value of that key; prints nothing |

\`flow.define\` passes \`opts.noEscape\` as \`noEscape\`: \`await flow.define(boxes, { noEscape: true })\`. The helper holds no state. After a kernel restart the flow is unchanged: load the helper again, or call \`tool.flow\` directly.`;

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
