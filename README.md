# omp-subagent-more

[中文](README.zh-CN.md)

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin for subagent work:

- **`fork_task`**: native `task` subagents that start from a copy of the caller's conversation, or of another agent named by an item's `from`. Its parameters are described on the tool itself; limits and batching are in `xd://fork_task/limits` and `xd://fork_task/batch`.
- **`fork:self`**: the internal agent every fork child is dispatched as. It is not meant to be named in `task` calls.
- **report-limit**: a check on every `fork_task` call that blocks items dispatched to `task:*` (or with `agent` omitted) whose shared `context` or `task` caps the length of the worker's report. Long reports belong in a file such as `local://<name>.md`.
- **Orchestration in eval** (skill `omp-subagent-more`): after `%load skill://omp-subagent-more/orchestrate.js` in a JS cell, `orchestrate(spec)` runs items of one or more subagent stages, each stage checked against its schema. A subagent that needs a decision yields `needs_input`; `drive()` returns at once with the question, and `answer(id, text)` sends the reply to the same subagent. Items do not wait for each other. Usage: `read skill://omp-subagent-more`.

## Install

```bash
omp plugin install https://github.com/oh-my-omp/omp-subagent-more#release
```

`fork_task` needs OMP's async subagents: `async.enabled: true` in `config.yml`.

Machines that run [omp-config](https://github.com/oh-my-omp/omp-config) get this plugin from omp-config's updater, which installs it and then removes omp-config's old local `fork-task` extension in the same update. Do not install it by hand there: with both copies loaded, OMP registers `fork_task` twice.

omp-config's light mode (`omp-light`) disables the extension `fork-task` by name, which is this plugin's entry; light sessions have no `fork_task`.

## report-limit model

The check asks the model role `@omp-subagent-more`; assign it in `/model` with "+ New role". Unassigned, it uses the `default` role chain. Each judgment has 25 seconds for the whole chain. No model, a failed request or an answer that does not parse lets the call run. Every judged call logs one `omp-subagent-more report-limit verdicts` line.

## Development

```bash
bun install
bun run check   # biome check . && tsc --noEmit
bun run test    # bun test tests
```

The tests drive the pure parts (staging rewrites, replica copies, workspace records and rejection codes, the report-limit verdicts, the orchestration state transitions over a fake eval prelude) with fixed inputs and no model. Hooks, worker threads and the spawn path need a real OMP session.

A pull request stages its change and writes the entry under `## [Unreleased]` in `CHANGELOG.md` with [lgit](https://github.com/can1357/llm-git): `git add` it, then run `uvx --from lgit-cli lgit` instead of `git commit`. A daily run at 02:00 GMT+9 promotes `## [Unreleased]` into a version section, tags it and moves the `release` branch, which is what `#release` installs.
