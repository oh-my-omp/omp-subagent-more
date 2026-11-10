# omp-subagent-more

[中文](README.zh-CN.md)

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin for subagent work:

- **`fork_task`**: native `task` subagents that start from a copy of the caller's conversation, or of another agent named by an item's `from`. Its parameters are described on the tool itself; limits and batching are in `xd://fork_task/limits` and `xd://fork_task/batch`.
- **`fork:self`**: the internal agent every fork child is dispatched as. It is not meant to be named in `task` calls.
- **report-limit**: a check on every `fork_task` call that blocks items dispatched to `task:*` (or with `agent` omitted) whose shared `context` or `task` caps the length of the worker's report. Long reports belong in a file such as `local://<name>.md`.

## Install

```bash
omp plugin install https://github.com/oh-my-omp/omp-subagent-more
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

The tests drive the pure parts (staging rewrites, replica copies, workspace records and rejection codes, the report-limit verdicts) with fixed inputs and no model. Hooks, worker threads and the spawn path need a real OMP session.

Changes go under `## [Unreleased]` in `CHANGELOG.md`.
