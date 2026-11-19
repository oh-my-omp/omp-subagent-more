# omp-subagent-more

[English](README.md)

- **对话分叉（`fork_task`）**
  - `fork_task` 工具 — 功能：派发原生 `task` 子代理，在源会话完全相同的 system prompt、工具和消息前缀下继续一段复制来的对话，同一源的各个分叉共享 provider 的前缀缓存。时机：模型调用 `fork_task` 时（顶层工具，`loadMode: "essential"`）；需要 `async.enabled: true` 和已落盘的会话。实例：`fork_task({ context: "…", tasks: [{ task: "Write tests for src/auth", name: "Tests", isolated: true }] })` 返回形如 `Tests_3f2a` 的子代理 id。
  - `from` 源 — 功能：分叉另一个已注册 agent（运行中、空闲或已 park）的对话，而不是调用者自己的；已 park 的源用它 park 时保留的请求分叉，不唤醒它。时机：条目设置 `from` 时。实例：`{ from: "ReadmeConfig", task: "…" }`。
  - `agent` 角色绑定 — 功能：子代理采用该 agent 的模型绑定（`task.agentModelOverrides`，否则定义里的 `model`），定义正文以 `<role agent="…">` 块放在任务开头，工具仍沿用源会话的。时机：条目设置 `agent` 时。实例：`{ agent: "reviewer", task: "…" }` 会在共享 `context` 前放上 `<role agent="reviewer">…</role>`。
  - `effort` 映射 — 功能：把 `lo`/`med`/`hi` 映射到目标模型自己的思考档位范围（最低、居中、最高）。时机：条目设置 `effort` 时；`task.enableEffort` 为 false 时无效。实例：`{ effort: "hi", task: "…" }`。
  - `shake` 精简 — 功能：对继承的对话执行与 `/shake` 相同的 `session.shake("elide")`，保留最新的 token 和 `skill://`/`local://PLAN.md` 读取，并把摘要附在工具结果后。时机：暂存阶段，条目设置 `shake: true` 时。实例：结果末尾为 `[fork_task] <name>: <shake summary>`。
  - `outputSchema` / `schemaMode` — 功能：把 JSON Schema（以 JSON 文本给出）及其执行模式交给子代理的 `yield`；JSON 无效时整次调用在暂存前被拒。时机：派发时。实例：`outputSchema: '{"type":"object","properties":{"report":{"type":"string"}},"required":["report"]}'`，错误 `tasks[0].outputSchema is not valid JSON: …`。
  - 深度与前提检查 — 功能：调用者的 `taskDepth` + 1 达到 `task.maxRecursionDepth`、`task` 不可用或没有后台任务时，在暂存前拒绝。时机：每次 `fork_task` 调用开始时。实例：``fork_task: requires background jobs (`async.enabled: true`).``
- **分叉子代理看到的内容**
  - `fork:self` agent — 功能：每个分叉子代理派发时使用的内部 agent 定义，其提示词和工具被替换为源会话的，模型固定。时机：每次 `fork_task` 派发；不在 `task` 调用里点名。实例：`agents/fork-self.md`，`name: fork:self`。
  - 分叉通知 — 功能：在复制的对话之后追加 `<system-notice cause="fork_task">`，说明历史只作背景、职责是随后的任务、交付前必须做 runtime 验证，以及子代理的工作区位置。时机：在子代理第一轮之前写入暂存的子代理对话。实例：`Above: the conversation of the parent agent that spawned you, copied as background. You continue under its system prompt and tools.`
  - 暂存进 artifact 存储 — 功能：把暂存的对话按预分配的 spawn key 移入父会话的 artifact 存储，让执行器打开的是分叉而不是空会话；目标已存在时拒绝覆盖。时机：宿主 `before_subagent_spawn` 钩子，仅 `task` 调用。实例：拦截原因 `fork_task: <path>.jsonl already exists; refusing to overwrite it.`
  - 请求复刻 — 功能：在子代理会话上装入源会话捕获的请求（system prompt、工具列表、消息前缀）；快照缺失时在任何模型调用前拦下子代理，而不是换一份契约运行。时机：子代理会话的 `before_agent_start`。实例：`the fork's request snapshot is no longer available; create a fresh fork from the parent`。
  - 自有 `yield` 提醒 — 功能：告诉运行在源模型上的子代理，它的 `yield` 不在工具列表里（列表保持父会话的以复用缓存），必须从 eval 单元调用，并附上该工具的说明和 JSON Schema。时机：`before_agent_start` 时以上下文差分注入；压缩丢掉它后，在 `tool_result` 的一批工具之后再次注入。实例：``Call it from a JavaScript `eval` cell, never as a direct tool call: `await tool.yield({ data: … })` ``。
  - 桥接 `yield` 转发 — 功能：把经 eval 桥执行的 `yield` 重新发成 `tool_execution_end` 事件，让任务执行器看到子代理的结果。时机：分叉子代理的 `tool_result`，且该调用不在 agent 循环的待处理调用里时。实例：`emitExternalEvent({ type: "tool_execution_end", toolName: "yield", … })`。
  - 跨线程源通道 — 功能：响应本进程其他线程对某个源最新请求的查询。时机：扩展加载时启动。实例：`BroadcastChannel("omp-fork-task/source")`。
- **工作区继承（`workspace: "source"`）**
  - 源改动叠加 — 功能：把 `from` agent 在它自己隔离工作区里的未提交改动应用到子代理的隔离副本上，与子代理自己的改动一起交回。时机：派发前检查；在子代理的 `before_agent_start` 应用，先记录工作区起点，再于第一轮之前叠加。实例：`{ from: "Impl_1a2b", workspace: "source", task: "…" }`。
  - 拒绝代码 — 功能：派发前以带代码的原因拒绝整次调用（`child-not-isolated`、`source-not-isolated`、`source-running`、`source-handed-back`、`nested-repo`、`overlay-conflict`）；迟到的 `overlay-conflict` 让子代理在第一次模型调用前停下。时机：暂存阶段；迟到冲突在子代理第一轮。实例：`workspace "source" rejected (source-running)`。
  - 工作区起点记录 — 功能：记录每个隔离子代理的工作区起点，供之后读取继承的改动。时机：每份子代理对话第一次 `before_agent_start`。实例：`<tmp>/omp-fork-task/starts/<pid>/`。
- **Topic**
  - `xd://fork_task/limits` — 功能：列出前提、不支持的字段、源错误和 `workspace "source"` 拒绝表。时机：模型读取时；工具说明最后几行指向它。实例：``Not fork fields: `steps`, `solutionSpace`, `model`, `tools`.``
  - `xd://fork_task/batch` — 功能：说明如何从 eval 按模板批量分叉。时机：模型读取时。实例：在 eval 单元里 `await tool.fork_task(...)`；结果送达对话而不是单元。
- **报告长度检查**
  - 报告长度判定 — 功能：共享 `context` 或条目 `task`（`agent` 为 `task:*` 或省略的条目）限制了 worker 报告长度时拦下 `fork_task` 调用，每个条目问模型一个问题，总时限 25 秒。时机：每次 `fork_task` 的 `tool_call`，执行之前。实例：拦截原因 ``禁止限制 task 系列 subagent 的报告字数：… 删掉字数/长度限制后重新派发；报告长时让 worker 写入文件（如 `local://<name>.md`）…``。
  - `@omp-subagent-more` 模型角色 — 功能：判定先问这个角色，再走 `default` 角色链；没有模型、请求失败或回答无法解析时放行。时机：每次判定。实例：在 `/model` → "+ New role" 绑定；模型须回答 `report-limit: true` 或 `report-limit: false`。
  - 判定缓存与日志 — 功能：每个进程只记住 `clear` 判定（对去空白的 context 和 task 取 sha256），每次判定过的调用写一行日志。时机：每次判定之后。实例：日志行 `omp-subagent-more report-limit verdicts`。
- **进程级记录与清理**
  - replica、overlay、parked、start 目录 — 功能：按进程保存每个子代理的请求副本、继承的改动、已 park 源的最新请求和工作区起点。时机：暂存和 spawn 时写入。实例：`<tmp>/omp-fork-task/replicas/<pid>/`、`overlays/<pid>/`、`parked/<pid>/`。
  - 启动清扫 — 功能：删除已不存在的进程留下的这些目录。时机：主会话的 `session_start`。实例：崩溃的 omp 留下的 `replicas/<pid>/` 在下次启动时被删。
  - 关闭清理 — 功能：主会话关闭时删除本进程的记录；任何会话关闭时删除它未派发分叉的暂存对话。时机：`session_shutdown`。实例：失败时记录 `fork_task: removing per-process records failed`。
- **eval 编排（skill `omp-subagent-more`）**
  - `orchestrate(spec)` — 功能：运行由子代理阶段组成的条目，每个阶段一次 `agent()` 调用，以 `schemaMode: "strict"` 按其 `data` JSON Schema 检查；条目之间互不等待。时机：JS 单元执行 `%load skill://omp-subagent-more/orchestrate.js` 之后。实例：`const run = orchestrate({ items: [{ id: "auth", stages: [{ task: "Read src/auth…", data: {…} }] }] })`。
  - `run.drive()` / `run.status()` — 功能：推进所有条目，全部结束或出现新问题时返回 `{ done, failed, needs_input, running }`；`status()` 只返回视图不推进。时机：编排单元调用；后台结果唤醒会话后再次调用。实例：`const view = await run.drive();`。
  - `needs_input` 协议与 `run.answer()` — 功能：阶段遇到任务未定的决定时 yield `{"kind": "needs_input", "question": "…", "options": […]}`，`answer(id, text)` 把回复发给同一个子代理。时机：阶段遇到任务留空的决定时。实例：`await run.answer("auth", "Keep the old API.");`。
