# `flow` 编排原语完整技术规范

本文档定义 `omp-subagent-more` 中 `flow` 编排原语的数据模型、引用解析、Redux 状态机、会话交接协议与 REPL 接口规范（对应 [`prototype/flow/`](../../prototype/flow/) 的实现）。

---

## 1. 盒子定义（Boxes）与引用语法（References）

一条流程（Flow）由一组按名字相互引用的**盒子（Box）**组成。盒子定义是纯 JSON 数据，不含任何 JS 函数或闭包（见 [`defs.ts`](../../prototype/flow/defs.ts)）。

### 1.1 两种盒子类型

#### （1）Agent 盒子（`AgentBox`）
每次点火启动一个全新的子代理会话，通过 `yield` 交回结构化结果或抛出预声明的业务异常：

```json
{
  "agent": "flow:worker",
  "model": "task:low",
  "brief": "Implement slice:\n{{slice}}\n\nRulings:\n{{rulings}}",
  "in": {
    "slice": "scout.slices[]",
    "rulings": "rule"
  },
  "out": {
    "type": "object",
    "required": ["files"],
    "properties": {
      "files": { "type": "array", "items": { "type": "string" } }
    }
  },
  "raises": ["question"],
  "handle": { "session": 1 },
  "isolated": true,
  "prepare": "bun install",
  "limit": 2,
  "bound": 3
}
```

#### （2）Command 盒子（`CommandBox`）
每次点火在调用方的工作目录（`cwd`）以 POSIX shell 语法执行一条命令，标准输出（去除尾部空白）即为盒子的字符串结果：

```json
{
  "command": "bun test {{work}}",
  "in": { "work": "work[]" },
  "checks": "work",
  "handle": { "exit": 1 },
  "limit": 1
}
```

### 1.2 字段完整定义

| 字段 | 适用盒子 | 类型 | 语义 |
|---|---|---|---|
| `agent` | Agent | `string` (必填) | 子代理使用的 Agent 定义名（决定其 `systemPrompt`、`tools`、`thinkingLevel`）。 |
| `model` | Agent | `string?` | 借用哪个 Agent 的模型绑定设置（优先读 `task.agentModelOverrides[model]`，否则读该 Agent 定义的 `model`），例如 `"task:low"`。省略时使用 `agent` 自身的模型绑定。 |
| `brief` | Agent | `string` (必填) | 任务书模板。`{{name}}` 会被替换为 `in.<name>` 的文本（字符串保持原样，其余类型序列化为缩进 JSON）。 |
| `command` | Command | `string` (必填) | POSIX shell 命令模板。`{{name}}` 会经过 `shellWord()` 转义为单个安全的单引号 shell 词，防止命令注入。 |
| `in` | 两者 | `Record<string, string>?` | 输入名到引用路径的映射（见 1.3 节）。 |
| `out` | Agent | `JsonObject` (必填) | 子代理正常完成时 `value` 的 JSON Schema。 |
| `raises` | Agent | `string[]?` | 允许子代理主动抛出的业务异常名列表（如 `["question", "blocked"]`）。 |
| `handle` | 两者 | `Record<string, number>?` | 命名的运行时异常 → 允许原地自动重新点火（refire）的最大次数。 |
| `isolated` | Agent | `boolean?` | 三态：`true` 表示每个会话在独立 git worktree 中运行并自动继承同一单元上一会话留下的未交回变更；`false` 表示显式共享调用方工作区（用于只读/计算型盒子，避免触发 isolation-nudge 拦截）；省略则遵循宿主默认设置。 |
| `prepare` | Agent | `string?` | 在子代理会话首轮开始前、在子代理自己的工作区内执行的 shell 命令（支持 `{{name}}` 替换，如 `"bun install"`）。失败时会话不启动，记为 `session` 异常。 |
| `checks` | Command | `string?` | 声明该命令盒子是对指定 Agent 盒子的门禁检查（见第 4 节）。 |
| `limit` | 两者 | `number?` | 该盒子同时处于 `running` 状态的最大单元数。省略表示不限并发。 |
| `bound` | Agent | `number?` | 单个单元通过“抛出问题被答复”和“门禁拒绝重开”串联起来的最大会话总数（含首次会话）。默认值为 `3`。 |

### 1.3 四种输入引用语法（`Ref`）

| 语法示例 | 解析类型 (`RefSource`) | `multi` | 语义与单元展开规则 |
|---|---|---|---|
| `"input.issue"` / `"input.issue.body"` | `{ kind: "input", name: "issue" }` | `false` | 读取外部通过 `supply("issue", val)` 注入的值（或其子字段）。 |
| `"scout"` / `"scout.slices"` | `{ kind: "box", box: "scout" }` | `false` | 读取盒子 `scout` 的整体结果（若 `scout` 是扇出盒子，则为其所有单元结果的数组）或其子字段。需等上游全部单元 `done` 后才就绪。 |
| `"scout.slices[]"` / `"work[]"` | `{ kind: "box", box: "scout" }` | `true` | **数组扇出（Fan-out）**：上游数组每个元素生成当前盒子的一个独立单元，键名为 `<box>#0`, `<box>#1`, … |
| `"work!question"` | `{ kind: "raise", box: "work", type: "question" }` | `true` | **业务异常端口**：每当 `work` 的某个单元（如 `work#1` 在第 2 次尝试时）抛出 `question`，自动为当前盒子生成一个答复单元，键名为 `<box><work#1@2>`。输入值为 `{ item, type, detail, handoff, board }`。 |

### 1.4 静态合法性检查（`lint`）
在 `define` 和 `run` 时，[`plan.ts`](../../prototype/flow/plan.ts) 执行以下静态检查，任何一项不满足则拒绝执行并一次列出全部问题：
1. **单重展开限制**：一个盒子的 `in` 中最多只能有 **1 个** `multi: true`（`[]` 或 `!type`）引用。
2. **模板占位符完备**：`brief`、`command`、`prepare` 中出现的每个 `{{name}}` 必须在 `in` 中有定义。
3. **引用源存在性**：`box` 引用指向的盒子必须已定义；`<box>!<type>` 指向的盒子必须是 Agent 盒子且其 `raises` 包含 `<type>`。
4. **异常处理器唯一性**：同一个 `<box>!<type>` 最多只能被 **1 个** 下游盒子引用。
5. **无依赖环（DAG）**：沿 `box` 引用边遍历不得存在环（`cycle: a → b → a`）。
6. **`checks` 对齐约束**：声明 `checks: "work"` 的命令盒子：① `work` 必须是已定义的 Agent 盒子；② `work` 本身不能是接 `!type` 的答复盒子；③ 命令盒子必须至少有一个输入引用自 `work`；④ 若 `work` 是扇出盒子（`isFanned`），命令盒子必须以 `work[]` 作为输入，从而保证 `check#i` 与 `work#i` 一一对应。

---

## 2. 集中式状态机（Redux Store & Action Log）

状态管理器（[`state.ts`](../../prototype/flow/state.ts)、[`store.ts`](../../prototype/flow/store.ts)、[`journal.ts`](../../prototype/flow/journal.ts)）是纯函数式的：磁盘上的 `flow.jsonl` 是唯一持久物，内存中的 `State` 完全由 `replay(actions)` 折叠得出。

### 2.1 状态结构（`State`）

```ts
type State = {
  readonly raw: Readonly<Record<string, Json>>;    // 原始盒子定义 JSON
  readonly boxes: Readonly<Record<string, Box>>;   // 解析后的盒子定义
  readonly inputs: Readonly<Record<string, Json>>; // 外部 supply 的输入值
  readonly agents: Readonly<Record<string, string>>; // 观测到的外部 Agent 定义指纹与模型绑定指纹
  readonly items: Readonly<Record<string, Item>>;  // 已产生的工作单元实例
  readonly mode: Mode;                             // "idle" | "running" | { kind: "stopped", cause: StopCause }
};
```

每个工作单元（`Item`）的键名规则：
- 单例盒子：`scout`
- 扇出盒子：`<box>#<index>`（如 `work#0`、`work#1`）
- 答复盒子：`<handlerBox><<sourceKey>@<attempt>>`（如 `answer<work#1@1>`）

### 2.2 三层定义指纹与过期（Stale / Illegal）机制

为了解决 REPL 中修改定义或外部修改 Agent 文件后“新定义与旧状态对不上”的问题，每个单元在点火（`fired`）时记录当时的综合指纹 `markOf(state, box)`：
- **Command 盒子**：`box.fingerprint`（定义 JSON 键排序后的 SHA-256 前 12 位）。
- **Agent 盒子**：`${box.fingerprint}+${agentPromptToolsHash}+${modelBindingHash}`。每次调用 `flow` 工具时，宿主先执行 `lookUpAgents` 采集当前会话中所有引用到的 Agent 的 `[systemPrompt, tools, thinkingLevel]` 哈希与 `model` 绑定哈希，若有变化则记入 `observed` Action。

由此自动推导出两种阻断 `run` 的状态：
- **`stale`（已过期）**：单元处于 `done` 或 `raised`，但其 `item.fingerprint !== markOf(state, box)`。调用方必须对该单元执行 `keep`（更新其指纹，认可旧值在当前定义下依然有效）或 `retract`（作废重算）。
- **`illegal`（非法）**：单元所属的 `box` 已被删除（`define({ box: null })`）。调用方必须 `retract` 该单元或重新定义该盒子。

### 2.3 级联失效（`dependents`）

当调用 `supply(name, newValue)` 覆盖外部输入、调用 `retract(keys)` 撤回单元/输入、或者 `checks` 门禁拒绝某个单元的结果时，[`state.ts:156-191`](../../prototype/flow/state.ts#L156-L191) 的 `dependents()` 会传递性地找出所有直接或间接依赖它的下游单元并从 `state.items` 中一并清除，确保状态图中永远不存在基于旧输入算出的孤儿结果。

### 2.4 14 种日志动作（`Action`）

| Action `kind` | 产生时机 | 状态折叠效果 (`reduce`) |
|---|---|---|
| `defined` | `flow.define(boxes)` 通过校验且指纹有变化 | 更新或删除 `raw` 与 `boxes` |
| `supplied` | `flow.supply(name, value)` 值有变化 | 更新 `inputs[name]`，级联删除依赖该输入的下游 `items` |
| `observed` | 宿主检测到外部 Agent 定义或模型设置变化 | 更新 `state.agents` 中的外部哈希标记 |
| `retracted` | `flow.retract(...keys)` | 删除指定输入/单元及其全部传递依赖项 |
| `kept` | `flow.keep(...keys)` | 将指定 `stale` 单元的 `fingerprint` 刷新为当前 `markOf` |
| `retried` | `flow.retry(...keys)` | 将指定 `failed` 单元的 `phase` 改为 `retry` |
| `answered` | `flow.answer(key, value)` | 为处于 `raised` 的单元写入外部答复 `item.answer` |
| `started` / `resumed` | `flow.run()` 通过全部合法性检查 | `mode` 设为 `{ kind: "running" }` |
| `halted` | `flow.stop(reason)` 或进程崩溃重启后 `recover()` | `mode` 设为 `{ kind: "stopped", cause: { kind: "halt", reason } }` |
| `idled` | 调度器发现 `ready` 与 `running` 均为空 | `mode` 从 `running` 设为 `{ kind: "idle" }` |
| `fired` | 调度器启动一个就绪单元 | 创建/更新 `item`，`phase: "running"`，若前态为 `raised` 或 `reopened` 则 `chain + 1` |
| `spawned` | `task` 工具分配了子代理会话 ID | 记录 `item.session = sessionId` |
| `settled` | 子代理会话或命令执行结束 | 调用 `settle()` 将 `Outcome` 折叠为最终 `Phase`（见第 4 节） |

---

## 3. 单次点火契约（Session, Handoff, Whiteboard & Workspace）

### 3.1 严格交回协议（`yieldSchema`）
每个 Agent 盒子通过 `task` 工具派发时，固定设置 `schemaMode: "strict"`，其 `outputSchema` 由 [`session.ts`](../../prototype/flow/session.ts) 生成：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "handoff"],
  "properties": {
    "status": { "enum": ["done", "raise"] },
    "value": { "...": "盒子的 out Schema" },
    "raise": { "enum": ["盒子的 raises 列表"] },
    "detail": { "type": "string" },
    "handoff": {
      "type": "object",
      "additionalProperties": false,
      "required": ["did", "decided", "unverified"],
      "properties": {
        "did": { "type": "string" },
        "decided": { "type": "array", "items": { "type": "string" } },
        "unverified": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```
- 任务书末尾自动追加 `## How to finish` 说明：严禁调用子代理的 `ask` 工具，严禁使用 `yield` 的 `error` 参数，必须通过 `yield({ data: ... })` 提交。
- 若交回对象缺少 `handoff`、`status: "done"` 缺少 `value`、或 `status: "raise"` 抛出了未在 `box.raises` 声明的类型，均由 `interpret()` 判定为 `protocol` 运行时异常。

### 3.2 单元专属白板文件（Notes file）
- 路径：`<sessionDir>/flow-boards/<encodeURIComponent(item.key)>.md`。
- 同一 `item.key` 的历次会话在任务书中均会收到 `## Notes file` 段落，被告知先读后追加；当该单元抛出问题触发 `<box>!<type>` 答复盒子时，答复盒子的输入对象中也会自动附带 `board: "<path>"`。
- 当单元因 `retract` 或上游重算被移除时，`pruneBoards()` 自动删除对应的白板文件。

### 3.3 隔离工作区继承与 `prepare` 命令
对于 `isolated: true` 的 Agent 盒子，当同一 `item.key` 进行第 $N$ ($N > 1$) 次点火且存在上一次已结束的会话 `earlier: { session, yielded }` 时，[`host.ts:291-310`](../../prototype/flow/host.ts#L291-L310) 的 `inheritFrom()` 按以下优先级提取工作区变更：
1. **上一会话正常 `yield` 且宿主已自动合入主检出**（`earlier.yielded && cfgTaskIsolationApply` 且无残留分支）：无需额外 overlay，新 worktree 直接基于已更新的主检出创建。
2. **宿主未能合并而保留的任务分支**（`keptTaskBranch` 存在 `refs/heads/omp/task/<session>`）：调用 `inheritKeptBranch()` 计算 `git diff <merge-base>..<branch>` 作为 overlay 补丁。
3. **宿主释放的补丁文件**（`<sessionDir>/<session>.patch` 存在）：调用 `inheritReleasedPatch()` 读取补丁并校验 `git apply --check`。
4. **仍在存活或未释放的隔离目录**：调用 `inheritSourceWorkspace()` 对比首轮记录的 `recordStart` 基线生成增量补丁。

在子代理线程的 `before_agent_start` 钩子中，依次执行：
1. `recordStart(file, cwd, id)` 记录当前 worktree 的初始基线；
2. `applyOverlay(file, cwd)` 应用继承的补丁（失败则挂载 `BeforeModelCallHook` 抛错阻止模型运行）；
3. `prepareWorkspace(file, cwd)` 执行盒子的 `prepare` 命令（超时 240s，非零退出同样阻止模型运行）。

---

## 4. 业务回路 vs 运行时异常

`flow` 严格区分**业务编排回路（flow loop）**与**运行时异常（runtime exception）**：

| 维度 | 业务回路 1：模型主动抛出 (`raise`) | 业务回路 2：门禁检查拒绝 (`checks`) | 运行时异常 (`failed`) |
|---|---|---|---|
| **触发条件** | 子代理 `yield` 返回 `status: "raise"` | 带 `checks: "<box>"` 的命令盒子以退出码 `1–125` 结束 | `spawn` / `workspace` / `session` / `schema` / `protocol` / `bound_exceeded` / `exit` (普通命令非零或检查命令 `126+`) / `timeout` / `host` |
| **是否停止整条流** | **否**（其他就绪单元继续运行） | **否**（直接重开被检查的单元） | 若 `spent < box.handle[name]` 则原地重火；**否则整条流立即 `STOPPED` 并取消所有在跑会话** |
| **下游产物处理** | 尚未产生下游产物 | 调用 `dependents()` 级联清除该单元此前产出的所有下游结果（含本次 `check` 自身） | 保留已有上游产物，当前单元进入 `failed` |
| **后续如何接回** | `<box>!<type>` 盒子产出结果或外部调用 `flow.answer()` 后，原单元带着 `{ kind: "answer", answer, previous: handoff }` 开新会话 | 原单元立即变为 `reopened`，下一轮调度带着 `{ kind: "check", check, output, previous: handoff }` 开新会话 | 调用方必须 `define`（修改该盒子定义）、`retract`（撤回）或 `retry`（显式重试）后才允许再次 `flow.run()` |
| **次数限制** | 计入 `item.chain`，若 `chain >= box.bound` 则升级为 `bound_exceeded` 异常停流 | 计入被检查单元的 `item.chain`，若 `chain >= checkedBox.bound` 则升级为 `bound_exceeded` 异常停流 | 按异常名独立计入 `item.refires[name]`，不消耗 `item.chain` |

---

## 5. `eval` REPL 表面与操作接口

### 5.1 工具层（`tool.flow`）
扩展注册名为 `flow` 的工具（`loadMode: "essential"`），附带三个按需读取的文档主题：
- `xd://flow/boxes`：盒子字段、引用语法、门禁检查与异常说明。
- `xd://flow/lifecycle`：10 个操作原语、判定输出格式、停止恢复与过期值处理。
- `xd://flow/eval`：在 `eval` JS cell 中调用 `tool.flow` 与加载 `helper.js` 的方法。

### 5.2 内核辅助层（`helper.js`）
通过 `%load <path>/helper.js` 加载后定义 `globalThis.flow`，自身不保存任何状态：

```js
await flow.define(boxes);          // 登记、覆盖或删除(null)盒子；打印 Verdict
await flow.supply(name, value);    // 注入外部输入 input.<name>；打印 Verdict
await flow.run();                  // 启动或恢复后台驱动 Job；打印 Verdict
await flow.stop(reason);           // 停止运行中的流；打印 Verdict
await flow.status();               // 打印完整接线图(wire)、汇总、下一步提示与所有单元状态
await flow.retract(...keys);       // 撤回输入或单元及其下游；打印 Verdict
await flow.keep(...keys);          // 确认保留过期(stale)单元的值；打印 Verdict
await flow.retry(...keys);         // 允许未改定义的 failed 单元重新点火；打印 Verdict
await flow.answer(key, value);     // 从外部答复未接线的 raise；打印 Verdict
const v = await flow.value(key);   // 静默读取 input.<name>、单元或盒子的存储值（不打印）
```

### 5.3 判定输出格式（Verdict）
每次除 `value` 外的调用均返回并由 `helper.js` 隐式 `print` 以下结构的文本（[`report.ts`](../../prototype/flow/report.ts)）：
1. **状态头行**：`flow running | complete | not running | STOPPED · X done · Y running · Z raised · W failed · V cancelled`
2. **停止原因与阻断项**（按需出现）：`cause: ...`、`problem: ...`、`needs: ...`、`waiting for inputs: ...`、`stale: ...`、`illegal: ...`、`raised and unanswered: ...`
3. **合法下一步提示**：`next: supply issue | keep or retract work#0 | run | stop`（由 [`store.ts`](../../prototype/flow/store.ts) 的 `moves(state)` 直接调用与 `judge` 相同的判定逻辑生成，保证列出的操作 100% 会被接受）。
4. **接线图**（仅 `status` 输出）：`wire work ← input.slices[] · raises question → answer · fires again on session ×1`
5. **状态增量（Delta）**：自上次 Verdict 以来新增（`+`）、变更（`~`）或移除（`-`）的盒子、输入与单元行。
