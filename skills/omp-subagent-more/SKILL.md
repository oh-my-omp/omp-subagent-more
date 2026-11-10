---
name: omp-subagent-more
description: Use for eval JS orchestration of many subagents with schema-checked results, multi-stage items without a global barrier, and subagents that stop to ask the orchestrator a question.
---

# Subagent orchestration in eval

A library for eval JS cells. Each **item** is a pipeline of **stages**; each stage is one subagent started with the prelude's `agent()`. Items do not wait for each other: an item's next stage starts as soon as its own previous stage is done.

## Load

A JS cell that is only this line:

```js
%load skill://omp-subagent-more/orchestrate.js
```

It defines `orchestrate` for the rest of the kernel's life. A kernel reset drops it and every orchestration in progress; load it again.

## Start and drive

```js
const run = orchestrate({
  context: "Shared background every stage receives first.",          // optional
  items: [
    {
      id: "auth",                                                     // unique string
      stages: [
        { task: "Read src/auth and list the public functions.", data: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] } },
        { task: "Write tests for those functions.", data: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] }, agent: "task:mid", isolated: true },
      ],
    },
  ],
});
const view = await run.drive();
```

A stage needs `task` (text) and `data` (the JSON Schema of the stage's result); `agent` and `isolated` pass through to `agent()`. Every stage is spawned with `schemaMode: "strict"`.

`drive()` advances every item and returns when either

- every item is `done`, `failed` or `needs_input`, or
- a stage asks a new question (`needs_input`), even while other items still run.

It returns with nothing pending, so the cell ends normally. The result:

```js
{
  done:        [{ id, results: [{ stage, data }] }],
  failed:      [{ id, stage, reason, results }],
  needs_input: [{ id, stage, question, options }],
  running:     [{ id, stage }],
}
```

`run.status()` returns the same view without advancing anything.

## The result protocol

Each stage's subagent is told to call `yield` with its `data` argument set to exactly one of:

- `{"kind": "done", "data": …}` with `data` matching the stage schema;
- `{"kind": "needs_input", "question": "…", "options": ["…"]}` when it reaches a decision the assignment leaves open, belongs to the orchestrator and must not be guessed. This is not a failure.

A subagent that is cancelled, exhausts its schema retries or ends in a yield error makes its item `failed`; other items continue.

## Answering

```js
await run.answer("auth", "Keep the old API.");
const next = await run.drive();
```

The answer goes to the **same** subagent as a message; it continues with its context and yields again (another question, or `done`). Answering an item that is not in `needs_input` throws.

## Being woken

Stages that finish while no `drive()` is running are delivered by OMP as background results, and an idle main session wakes on them. Call `drive()` again to take them in. Results that a `drive()` already collected do not wake the session a second time.

Typical loop: `drive()` → answer what is in `needs_input` → end the turn if items are still `running` → on the wake-up, `drive()` again.
