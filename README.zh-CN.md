# omp-subagent-more

[English](README.md)

[Oh My Pi](https://github.com/can1357/oh-my-pi) 的子代理插件：

- **`fork_task`**：从调用方对话的副本（或某一项 `from` 指定的另一个代理的对话副本）开始工作的原生 `task` 子代理。参数说明在工具定义里；上限与批量派发见 `xd://fork_task/limits` 与 `xd://fork_task/batch`。
- **`fork:self`**：每个分叉子代理派发时使用的内部 agent，不用在 `task` 调用里点名。
- **report-limit**：对每次 `fork_task` 调用的检查。派给 `task:*`（或未填 `agent`）的项，如果共享 `context` 或该项 `task` 限制了子代理报告的长度，整次调用被拦下。长报告应写入文件，例如 `local://<name>.md`。
- **eval 中的编排**（skill `omp-subagent-more`）：在 JS cell 里 `%load skill://omp-subagent-more/orchestrate.js` 后，`orchestrate(spec)` 按条目运行一到多个子代理阶段，每个阶段的结果按其 schema 校验。需要上级决定的子代理 yield `needs_input`，`drive()` 立即带着问题返回，`answer(id, text)` 把回答发给同一个子代理。条目之间互不等待。用法见 `read skill://omp-subagent-more`。

## 安装

```bash
omp plugin install https://github.com/oh-my-omp/omp-subagent-more
```

`fork_task` 需要 OMP 的异步子代理：`config.yml` 中 `async.enabled: true`。

运行 [omp-config](https://github.com/oh-my-omp/omp-config) 的机器由 omp-config 的更新器安装本插件，并在同一次更新里删除 omp-config 原来的本地 `fork-task` 扩展。这类机器不要手动安装：两份同时加载时，OMP 会注册两个 `fork_task`。

omp-config 的轻量模式（`omp-light`）按名字关闭扩展 `fork-task`，也就是本插件的入口；轻量会话没有 `fork_task`。

## report-limit 的模型

检查使用模型角色 `@omp-subagent-more`，在 `/model` 里用 "+ New role" 绑定；未绑定时使用 `default` 角色链。每次判定整条链共 25 秒。没有模型、请求失败或答案解析不出时放行。每次判定过的调用记一条 `omp-subagent-more report-limit verdicts` 日志。

## 开发

```bash
bun install
bun run check   # biome check . && tsc --noEmit
bun run test    # bun test tests
```

测试用固定输入、不调用模型，覆盖纯逻辑部分（暂存改写、副本、工作区记录与拒绝码、report-limit 判定、在假的 eval prelude 上的编排状态转移）。hook、worker 线程与派发路径需要真实的 OMP 会话。

变更写在 `CHANGELOG.md` 的 `## [Unreleased]` 下。
