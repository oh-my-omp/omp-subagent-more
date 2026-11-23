---
name: omp-subagent-ng
description: Use for eval JS orchestration of many small subagent sessions as a flow, whose deterministic hand-offs, checks and fan-out run without the main agent relaying between them.
---

# Flows of small subagent sessions in eval

A flow is a set of **boxes** wired to each other by name. An agent box starts one fresh subagent session per item and takes its structured `yield`; a command box runs one shell command per item. The flow decides what fires next from one append-only store, so the main agent neither dispatches each session nor relays results between them: it defines boxes, supplies outside values, runs the flow and is woken once, when the flow comes to rest or stops. What the flow cannot settle (an unanswered raise, a runtime exception) comes back to the main agent, which handles it the ordinary way and resumes.

## Load

A JS cell that is only this line:

```js
%load skill://omp-subagent-ng/flow.js
```

It defines `flow` for the kernel's life. The flow's state lives with the session, not in the kernel: after a kernel reset, load the helper again and the flow is unchanged.

## Define, supply, run

```js
const issue = JSON.parse(await sh`gh issue view 12 --json title,body`);
await flow.define({
  scout: { agent: "flow:scout", model: "task:mid", brief: "Split this request.\n\n{{issue}}", in: { issue: "input.issue" }, isolated: false,
    out: { type: "object", required: ["slices"], properties: { slices: { type: "array" } } } },
  work: { agent: "flow:worker", model: "task:low", brief: "Implement this slice of the request.\n\n{{slice}}\n\n{{issue}}",
    in: { slice: "scout.slices[]", issue: "input.issue" }, raises: ["question"], isolated: true, splits: 1, limit: 1, prepare: "bun install",
    out: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } } },
  answer: { agent: "flow:adjudicator", model: "task:high", brief: "Rule on what the worker raised.\n\n{{raise}}\n\n{{issue}}",
    in: { raise: "work!question", issue: "input.issue" }, isolated: false, out: { type: "object" } },
  gate: { command: "bun test", in: { work: "work[]" }, checks: "work" },
});
await flow.supply("issue", issue);
await flow.run();
```

Every call prints the store's verdict: the headline, what holds the flow back, the `next:` operations open now, and what changed; `noEscape: on` follows the headline while that mode is on. `run` returns at once; end the turn instead of waiting, and the flow's verdict arrives when it comes to rest or stops.

- `scout.slices[]` fans out: one `work` item per slice. A box may take several `[]` inputs; they pair by leaf path, and a path that only some of them reach is reported `unpaired` and keeps the flow from completing.
- `work!question` wires a raise: `answer` rules on it, and the raising item continues in a new session given the answer and its own handoff. A ruling box may instead send the worker back to probe with `done`; a product or scope question it cannot decide leaves the flow as an outward raise (such as `ask_user`) only when its schema offers one, and you answer it with `flow.answer`. An item's last allowed session is offered no raise at all.
- `gate` checks `work`. A command check reopens the item when its exit code is in `rejects` (`[1]` by default); an agent check yields `{"status": "reject", "feedback": "…"}`. Every checked item at that path reopens at once, in new sessions given their handoffs, the check's output or `feedback`, and the values the check was given that round. Any other non-zero exit, or a rejection from an item in its last allowed session, fails the item (`exit`, `bound_exceeded`); `bound_exceeded` stops the flow. Reopenings count towards each checked box's `bound`.
- `splits: 1` on `work` (which is `isolated`) lets a session that finds its slice too large ask you for a split: the request arrives as a message listing the parts, and the session stays blocked until you call `flow.agree("work#0")` or `flow.disagree("work#0", reason)`. After an agree each part becomes a `work` item of its own (`work#0.0`, `work#0.1`) whose first session is a fork of the splitting session, `gate` checks each leaf, and a box taking `work` gets every leaf's result. Nothing joins the parts.
- `noEscape` keeps everything inside the flow. `await flow.define(boxes, { noEscape: true })` refuses `run` until every input a box takes is supplied, offers only raise types some box answers, approves a valid split request without asking you, and fires `session`, `timeout`, `protocol` and `schema` failures once more when the box's `handle` does not name them. `false` lifts it; leaving it out keeps it as it is.
- Boxes are plain data: `define` one box again to change it, `null` drops it. Results produced under an earlier definition, agent prompt or model setting are reported stale until kept or retracted.

The fields, references, checks, sessions and exceptions are in `help://flow/boxes`; stopping, resuming, stale values, raises and split requests in `help://flow/lifecycle`; the eval helper in `help://flow/eval`.

## Presets and your own templates

`flow.use(spec, opts)` defines a spec and supplies its inputs. A spec is `{ boxes, inputs?, noEscape? }` or a plain boxes map; `opts.noEscape` overrides the spec's, and the spec's inputs are supplied first, then `opts.inputs`. Presets return such specs and call nothing:

```js
await flow.use(flow.presets.swarm(
  { model: "task:low", request: "input.issue", inputs: { issue }, gate: { command: "bun test" } },
  { name: "api", brief: "Build the API for {{issue}}", in: { issue: "input.issue" } },
  { name: "docs", brief: "Document {{issue}}", in: { issue: "input.issue" } },
));
```

`swarm` gives each named worker a `flow:worker` box, a `<name>_ruling` `flow:adjudicator` box wired to its `question`, an optional `gate` checking every worker, and an optional `reduce` taking every worker whole.

```js
await flow.use(flow.presets.loop(
  { over: "input.items[]", model: "task:low", rounds: 2, inputs: { items },
    check: { agent: "flow:guardian", model: "task:low", brief: "Judge {{red}} against {{blue}}", out: { type: "object" } } },
  { name: "red", brief: "Attack {{item}}" },
  { name: "blue", brief: "Defend {{item}}" },
));
```

`loop` fans every named agent over `over` (the input is `as`, `"item"` by default), pairs them by path in `check`, checks all of them at once, and reopens them together for up to `rounds` sessions.

A template of your own is a function that returns the same plain JSON spec. Export it from a module and `await import()` it, or put it on `globalThis` in a script without `export` and `%load` that script; then merge its boxes with any other spec:

```js
const { review } = await import("./review.js");
const red = flow.presets.loop({ over: "input.items[]", check: { command: "test -n {{red}}" } }, { name: "red", brief: "Attack {{item}}" });
await flow.use({ ...red, boxes: { ...red.boxes, ...review().boxes } });
```

Spreading overwrites a box of the same name with the later one; merge `inputs` and `noEscape` yourself the same way.

## Roles

| Agent | Role |
|---|---|
| `flow:scout` | Read-only split of one request into slices, open points and check gaps. |
| `flow:worker` | Implements one slice; raises what the assignment leaves open. |
| `flow:adjudicator` | Read-only rulings on raised or open points; never implements. |
| `flow:guardian` | Read-only judgment, once at the end, of whether the result is what was asked. |
| `flow:verifier` | Carries out one acceptance step as written; never repairs. |

None of them has a model of its own: `model` names the tier whose model setting the sessions use. Rules of the project go into the `brief`.
