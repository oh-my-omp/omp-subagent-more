---
name: omp-subagent-more
description: Use for eval JS orchestration of many small subagent sessions as a flow, whose deterministic hand-offs, checks and fan-out run without the main agent relaying between them.
---

# Flows of small subagent sessions in eval

A flow is a set of **boxes** wired to each other by name. An agent box starts one fresh subagent session per item and takes its structured `yield`; a command box runs one shell command per item. The flow decides what fires next from one append-only store, so the main agent neither dispatches each session nor relays results between them: it defines boxes, supplies outside values, runs the flow and is woken once, when the flow comes to rest or stops. What the flow cannot settle (an unanswered raise, a runtime exception) comes back to the main agent, which handles it the ordinary way and resumes.

## Load

A JS cell that is only this line:

```js
%load skill://omp-subagent-more/flow.js
```

It defines `flow` for the kernel's life. The flow's state lives with the session, not in the kernel: after a kernel reset, load the helper again and the flow is unchanged.

## Define, supply, run

```js
const issue = JSON.parse(await sh`gh issue view 12 --json title,body`);
await flow.define({
  scout: { agent: "flow:scout", model: "task:mid", brief: "Split this request.\n\n{{issue}}", in: { issue: "input.issue" }, isolated: false,
    out: { type: "object", required: ["slices"], properties: { slices: { type: "array" } } } },
  work: { agent: "flow:worker", model: "task:low", brief: "Implement this slice of the request.\n\n{{slice}}\n\n{{issue}}",
    in: { slice: "scout.slices[]", issue: "input.issue" }, raises: ["question"], isolated: true, limit: 1, prepare: "bun install",
    out: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } } },
  answer: { agent: "flow:adjudicator", model: "task:high", brief: "Rule on what the worker raised.\n\n{{raise}}\n\n{{issue}}",
    in: { raise: "work!question", issue: "input.issue" }, isolated: false, out: { type: "object" } },
  gate: { command: "bun test", in: { work: "work[]" }, checks: "work" },
});
await flow.supply("issue", issue);
await flow.run();
```

Every call prints the store's verdict: the headline, what holds the flow back, the `next:` operations open now, and what changed. `run` returns at once; end the turn instead of waiting, and the flow's verdict arrives when it comes to rest or stops.

- `scout.slices[]` fans out: one `work` item per slice.
- `work!question` wires a raise: `answer` rules on it, and the raising item continues in a new session given the answer and its own handoff.
- `gate` checks `work`: an exit code in its `rejects` (`[1]` by default) reopens the checked item in a new session with the output; any other failure stops the flow.
- Boxes are plain data: `define` one box again to change it, `null` drops it. Results produced under an earlier definition, agent prompt or model setting are reported stale until kept or retracted.

The fields, references, checks, sessions and exceptions are in `help://flow/boxes`; stopping, resuming, stale values and raises in `help://flow/lifecycle`; the eval helper in `help://flow/eval`.

## Roles

| Agent | Role |
|---|---|
| `flow:scout` | Read-only split of one request into slices, open points and check gaps. |
| `flow:worker` | Implements one slice; raises what the assignment leaves open. |
| `flow:adjudicator` | Read-only rulings on raised or open points; never implements. |
| `flow:guardian` | Read-only judgment, once at the end, of whether the result is what was asked. |
| `flow:verifier` | Carries out one acceptance step as written; never repairs. |

None of them has a model of its own: `model` names the tier whose model setting the sessions use. Rules of the project go into the `brief`.
