# OMP 宿主内部机制与桥接边界

本文档整理自会话 `01a1db88` 对 `@oh-my-pi/pi-coding-agent`（v18.18.8 – v18.20.2）源码的核查与真机实测（原 `local://flow-host-facts.md` 与 `local://flow-handback-decisions.md`），记录 `flow` 扩展在宿主边界依赖的确切机制与约束。

---

## 1. 为什么在扩展侧用单个后台 `AsyncJob` 驱动整条流？

### 宿主事实
- `session.asyncJobManager.register(type, label, run, options)`（`async/job-manager.ts`）对扩展注册的 Job 与宿主内置 Job 一视同仁。
- `type` 仅允许 `"bash" | "task" | "eval"`；`options.ownerId` 必须设为 `parent.getAgentId()`，否则 Job 完成时无法路由到主会话的 `#deliverySinks`（会被丢入死信队列，主会话永远收不到唤醒）。
- 当 `ownerId` 匹配且主会话处于空闲（`!isStreaming`）时，Job 的 `run` 函数返回的字符串会经由 `yieldQueue.enqueueWithReceipt("async-result", ...)` 自动触发 `injectIdle` → `agent.prompt(...)`，**唤醒主会话开启新一轮回复**。

### `flow` 的设计利用
- `flow.run()` 调用 `ensureDriver()`（[`host.ts`](../../prototype/flow/host.ts)），向 `asyncJobManager` 注册一个 `id: "flow"`、`ownerId: parent.getAgentId()` 的后台 Job。
- 该 Job 内部运行 `drive()` 循环：不断调用 `store.advance()` 启动就绪单元、等待单元结算、取消孤儿会话（`store.orphans`），直到 `store.state.mode.kind !== "running" && flow.running.size === 0` 时返回 `flow.store.changes().join("\n")`。
- 因此，无论流内部串联或并联了多少个子代理会话，**主会话只在整条流全部完成（`idle`）或因异常/未答复问题停下时被唤醒一次**。

---

## 2. 子代理派发、结果读取与单次完成通知的抑制

### 宿主事实
1. **编程式调用 `TaskTool.execute`**：
   - `parent.getToolByName("task").execute(toolCallId, { context, tasks: [item] })`（`task/index.ts`）在 `async.enabled: true` 时注册后台 Job 并立即返回。
   - `toolCallId` 必须使用全新的随机 ID（如 `` `flow-${randomUUID()}` ``）：`TaskTool` 仅用它查找流式推测启动表 `#launchSessions`，使用新 ID 是安全的空操作；若误复用正在流式生成的 `toolCallId` 则会窃取或丢弃其推测会话。
   - 返回值的 `details.progress[0].id` 即为分配给该子代理的 `agentId`（通常与 `jobId` 相同）。
2. **抑制单次子代理唤醒（`acknowledgeDeliveries`）**：
   - 默认情况下，每个子代理 Job 结束时都会向主会话投递一条 `<async-result>` 并唤醒主会话。
   - 调用 `manager.acknowledgeDeliveries([id])`（`async/job-manager.ts`）会将该 `jobId` 加入 `#suppressedDeliveries`，**永久抑制该子代理向主会话的完成投递与空闲唤醒**，而不会影响 `job.promise` 和 `job` 行上的状态写入。
3. **从 `AsyncJob` 行直接读取结构化交回结果**：
   - `await job.promise`（永远 resolve，内部已 try/catch）结束后，`manager.getJob(id)` 返回的 `job` 行包含：
     - `job.status`: `"running" | "completed" | "failed" | "cancelled"`
     - `job.structured`: `{ source, mode, status: "valid" | "invalid" | "unavailable", data?: unknown, error?: string }`
     - `job.resultText`（成功时的交付文本，含 `<merge-summary>`）与 `job.errorText`（失败或取消时的文本）。
   - 即使 Schema 校验失败导致 `job.status === "failed"`，`TaskJobError` 仍会将 `structured` 挂载到 `job.structured` 上，因此 [`host.ts`](../../prototype/flow/host.ts) 的 `outcomeOfJob()` 能精确区分 `schema`、`protocol` 与普通 `session` 失败。

---

## 3. 跨线程边界：为什么工作区补丁与 `prepare` 必须走磁盘文件？

### 宿主事实
- OMP 可能在独立的 **Subagent Worker 线程** 中运行子代理会话。每个 Worker 线程会重新加载一份独立的扩展模块实例（拥有各自独立的内存空间）。
- `before_subagent_spawn` 钩子运行在**父会话所在线程**，且在 `taskTool.execute()` 已经返回、后台 Job 正式启动子代理之前异步触发（因此父线程准备的 `rt.spawns` 条目必须保留到子代理结束或被钩子取走，见提交 `748f956`）。
- `before_agent_start` 钩子运行在**子代理所在线程**（可能是另一个 Worker 线程），此时子代理线程内存里的 `rt.spawns` 是空的！

### `flow` 的设计利用
- 在父线程的 `before_subagent_spawn` 中（[`host.ts`](../../prototype/flow/host.ts) 的 `beforeSubagentSpawn()`）：
  - 通过 `{ model: prepared.model }` 返回值直接覆盖子代理的模型绑定；
  - 将继承的工作区补丁通过 `writeOverlay(childFile, prepared.overlay)` 写入子代理会话 artifacts 目录下的 `fork-task.overlay.patch`；
  - 将填充好参数的 `prepare` 命令写入同目录下的 `fork-task.overlay.patch.prepare` 文件。
- 在子代理线程的 `before_agent_start` 中（[`host.ts`](../../prototype/flow/host.ts) 的 `beforeAgentStart()`）：
  - 根据自身的 `ctx.sessionManager.getSessionFile()` 得到同一个 artifacts 目录，依次执行 `recordStart` → `applyOverlay` → `prepareWorkspace`（读取并删除 `.prepare` 文件）。

---

## 4. 隔离工作区（Worktree）合入机制与陷阱

### 宿主事实（在真实运行中踩坑发现）
1. **Worktree 不包含被 `.gitignore` 忽略的文件**：
   - OMP 创建的隔离 worktree 是干净检出，没有主检出里的 `node_modules` 或构建产物，且 worktree 看不到主检出 `.git/info/exclude` 里的本地忽略项。
   - 如果让子代理自己建软链（如 `ln -s <repo>/node_modules node_modules`），而仓库 `.gitignore` 写的是目录匹配 `node_modules/`，软链不会被 git 忽略，会被宿主打包进任务提交并导致合回主检出时冲突失败！
   - 因此依赖安装必须通过盒子的 `prepare` 命令（如 `"bun install"`）在 worktree 内生成真实的被 `.gitignore` 忽略的目录。
2. **隔离子代理 `yield` 成功不代表改动已合入主检出**：
   - 当隔离子代理成功调用 `yield` 时，无论后续 git 合并是否成功，`job.status` 都是 `"completed"` 且 `job.structured.status === "valid"`。
   - 若合入主检出发生冲突，宿主在 `branch` 模式下会保留分支 `omp/task/<agentId>`（`task/isolation-runner.ts`），并在 `job.resultText` 的 `<merge-summary>` 块内写入转义后的 `&lt;system-notification>...` 提示文本。
   - `flow` 在 [`host.ts`](../../prototype/flow/host.ts) 的 `handBackFailure()` 中检查这一情况：一旦发现合入失败，将单元结果改判为 `failed("workspace", ...)` 停流，且下一次会话通过 `keptTaskBranch()` 直接从 `omp/task/<agentId>` 分支继承改动。
