# `flow` 编排原语完整技术规范

本文档定义 `omp-subagent-ng` 中 `flow` 编排原语的数据模型、引用解析、Redux 状态机、会话交接协议与 REPL 接口规范（对应 [`extensions/flow/`](../../extensions/flow/) 的实现）。

---

## 1. 盒子定义（Boxes）与引用语法（References）

一条流程（Flow）由一组按名字相互引用的**盒子（Box）**组成。盒子定义是纯 JSON 数据，不含任何 JS 函数或闭包（见 [`defs.ts`](../../extensions/flow/defs.ts)）。

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
  "bound": 3,
  "splits": 1
}
```

#### （2）Command 盒子（`CommandBox`）
每次点火在调用方的工作目录（`cwd`）以 POSIX shell 语法执行一条命令，标准输出（去除尾部空白）即为盒子的字符串结果：

```json
{
  "command": "bun test {{work}}",
  "in": { "work": "work[]" },
  "checks": "work",
  "rejects": [1],
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
| `in` | 两者 | `Record<string, string>?` | 输入名到引用路径的映射（见 1.3 节）。可声明多个 `[]` 输入，按叶子路径配对；最多 1 个答复端口，且不能与 `[]` 输入共存。 |
| `out` | Agent | `JsonObject` (必填) | 子代理正常完成时 `value` 的 JSON Schema。 |
| `raises` | Agent | `string[]?` | 允许子代理主动抛出的业务异常名列表（如 `["question", "blocked"]`）。 |
| `handle` | 两者 | `Record<string, number>?` | 命名的运行时异常 → 允许原地自动重新点火（refire）的最大次数。 |
| `isolated` | Agent | `boolean?` | 三态：`true` 表示每个会话在独立 git worktree 中运行并自动继承同一单元上一会话留下的未交回变更；`false` 表示显式共享调用方工作区（用于只读/计算型盒子，避免触发 isolation-nudge 拦截）；省略则遵循宿主默认设置。 |
| `prepare` | Agent | `string?` | 在子代理会话首轮开始前、在子代理自己的工作区内执行的 shell 命令（支持 `{{name}}` 替换，如 `"bun install"`）。失败时会话不启动，记为 `session` 异常。 |
| `checks` | 两者 | `string` 或 `string[]`，可选 | 门禁检查：命名一个 Agent 盒子，或非空数组命名多个（见第 4 节）。单个名字与数组等价，重复的名字只算一次。 |
| `rejects` | Command | `number[]?` | 仅与 `checks` 同用：表示“拒绝被检查结果”的退出码，取值 1–125，非空；省略时为 `[1]`。Agent 盒子不声明 `rejects`：它经 `yield` 的 `reject` 判定。 |
| `limit` | 两者 | `number?` | 该盒子同时处于 `running` 状态的最大单元数。省略表示不限并发。 |
| `bound` | Agent | `number?` | 单个单元通过“抛出问题被答复”和“门禁拒绝重开”串联起来的最大会话总数（含首次会话）。默认值为 `3`。最后一次会话不再被提供 `raise`。 |
| `splits` | Agent | `number?` | 一个元素最多可以被逐层拆分几层（见 4.1 节）：`1` 表示单元可以拆分、拆出的部分不能再拆。该盒子必须恰好有 1 个非答复端口的 `[]` 输入，并声明 `isolated: true`。省略表示会话不能拆分。 |

### 1.3 四种输入引用语法（`Ref`）

| 语法示例 | 解析类型 (`RefSource`) | `multi` | 语义与单元展开规则 |
|---|---|---|---|
| `"input.issue"` / `"input.issue.body"` | `{ kind: "input", name: "issue" }` | `false` | 读取外部通过 `supply("issue", val)` 注入的值（或其子字段）。 |
| `"scout"` / `"scout.slices"` | `{ kind: "box", box: "scout" }` | `false` | 读取盒子 `scout` 的整体结果（若 `scout` 是扇出盒子，则为其所有叶子结果的数组）或其子字段。需等上游全部单元 `done` 后才就绪。 |
| `"scout.slices[]"` / `"work[]"` | `{ kind: "box", box: "scout" }` | `true` | **数组扇出（Fan-out）**：上游数组每个元素生成当前盒子的一个独立单元，键名为 `<box>#0`, `<box>#1`, …；上游单元拆分过时，按上游的叶子逐个生成，键名沿用叶子的编号路径（`work#0.1` 对应 `check#0.1`）。 |
| `"work!question"` | `{ kind: "raise", box: "work", type: "question" }` | `true` | **业务异常端口**：每当 `work` 的某个单元（如 `work#1` 在第 2 次尝试时）抛出 `question`，自动为当前盒子生成一个答复单元，键名为 `<box><work#1@2>`。输入值为 `{ item, type, detail, handoff, board }`。每个盒子最多 1 个答复端口，且不能与 `[]` 输入共存。 |

一个盒子的 `in` 可以声明多个 `[]` 输入。它按叶子路径 `path`（`[0]`、`[0, 1]` 等）把各路元素求交集配对：所有 `[]` 输入在同一 `path` 都有元素时生成 `itemKey(box, path)` 单元，其 `inputs` 按输入名绑定该 `path` 上的值；上游单元拆分过时，路径继续追加部分序号（`a#0.1` 对应 `review#0.1`）。只有部分 `[]` 输入到达的路径不被生成为单元，而是作为未配对路径报告（列出缺失该路径的输入），并使该汇聚盒所属的流不能判定为 `flow complete`。声明 `splits` 的盒子只能有 1 个 `[]` 输入：拆出的部分只替换那一个元素。

### 1.4 静态合法性检查（`lint`）
在 `define` 时逐个盒子解析字段与引用，在 `define` 和 `run` 时 [`plan.ts`](../../extensions/flow/plan.ts) 执行以下静态检查，任何一项不满足则拒绝执行并一次列出全部问题：
1. **引用源存在性**：`box` 引用指向的盒子必须已定义；`<box>!<type>` 指向的盒子必须是 Agent 盒子且其 `raises` 包含 `<type>`。
2. **答复端口唯一**：每个盒子的 `in` 最多有 **1 个** `<box>!<type>` 引用，且不能与 `[]` 输入共存。数组扇出本身不限个数。
3. **模板占位符完备**：`brief`、`command`、`prepare` 中出现的每个 `{{name}}` 必须在 `in` 中有定义。
4. **异常处理器唯一性**：同一个 `<box>!<type>` 最多只能被 **1 个** 下游盒子引用。
5. **无依赖环（DAG）**：沿 `box` 引用边遍历不得存在环（`cycle: a → b → a`）。
6. **`checks` 对齐约束**：对 `checks` 中每个目标盒逐一校验：① 目标盒已定义且是 Agent 盒子；② 目标盒本身不接答复端口（其单元才能被重开）；③ 检查盒必须直接或经由中间普通盒子引用该目标盒的输出；④ 若目标盒是扇出盒子，检查盒必须以同路径的镜像 `[]` 引用链到达它（如 `work[]`），或该检查盒本身是取 `work[]` 的盒子；⑤ 检查盒若自己也声明 `splits`，则不能检查扇出盒子，因为其部分路径对不上被检查盒的单元。
7. **拆分需要扇出与隔离**：声明 `splits` 的 Agent 盒子必须恰好有 1 个非答复端口的 `[]` 输入，拆出的部分替换的就是这个输入的元素；它还必须声明 `isolated: true`，因为各部分以隔离的 fork 运行。

---

## 2. 集中式状态机（Redux Store & Action Log）

状态管理器（[`state.ts`](../../extensions/flow/state.ts)、[`store.ts`](../../extensions/flow/store.ts)、[`journal.ts`](../../extensions/flow/journal.ts)）是纯函数式的：磁盘上的 `flow.jsonl` 是唯一持久物，内存中的 `State` 完全由 `replay(actions)` 折叠得出。

### 2.1 状态结构（`State`）

```ts
type State = {
  readonly raw: Readonly<Record<string, Json>>;    // 原始盒子定义 JSON
  readonly boxes: Readonly<Record<string, Box>>;   // 解析后的盒子定义
  readonly inputs: Readonly<Record<string, Json>>; // 外部 supply 的输入值
  readonly agents: Readonly<Record<string, string>>; // 观测到的外部 Agent 定义指纹与模型绑定指纹
  readonly items: Readonly<Record<string, Item>>;  // 已产生的工作单元实例
  readonly mode: Mode;                             // "idle" | "running" | { kind: "stopped", cause: StopCause }
  readonly noEscape: boolean;                      // 全局封口开关，默认 false
};
```

`noEscape` 由 `define` 的可选布尔参数设置，随 `defined` 事件持久化与回放；历史日志没有该字段时回放为 `false`。

每个工作单元（`Item`）的键名规则：
- 单例盒子：`scout`
- 扇出盒子：`<box>#<index>`（如 `work#0`、`work#1`）
- 拆分出的部分：在被拆单元的键名后追加序号，形成编号路径（如 `work#0` 拆成 `work#0.0`、`work#0.1`，`work#0.1` 再拆成 `work#0.1.0`）
- 答复盒子：`<handlerBox><<sourceKey>@<attempt>>`（如 `answer<work#1@1>`）

### 2.2 三层定义指纹与过期（Stale / Illegal）机制

为了解决 REPL 中修改定义或外部修改 Agent 文件后“新定义与旧状态对不上”的问题，每个单元在点火（`fired`）时记录当时的综合指纹 `markOf(state, box)`：
- **Command 盒子**：`box.fingerprint`（定义 JSON 键排序后的 SHA-256 前 12 位）。
- **Agent 盒子**：`${box.fingerprint}+${agentPromptToolsHash}+${modelBindingHash}`。每次调用 `flow` 工具时，宿主先执行 `lookUpAgents` 采集当前会话中所有引用到的 Agent 的 `[systemPrompt, tools, thinkingLevel]` 哈希与 `model` 绑定哈希，若有变化则记入 `observed` Action。

由此自动推导出两种阻断 `run` 的状态：
- **`stale`（已过期）**：单元处于 `done`、`raised` 或 `split`，但其 `item.fingerprint !== markOf(state, box)`。调用方必须对该单元执行 `keep`（更新其指纹，认可旧值在当前定义下依然有效）或 `retract`（作废重算）。
- **`illegal`（非法）**：单元所属的 `box` 已被删除（`define({ box: null })`）。调用方必须 `retract` 该单元或重新定义该盒子。

### 2.3 级联失效（`dependents`）

当调用 `supply(name, newValue)` 覆盖外部输入、调用 `retract(keys)` 撤回单元/输入、或者 `checks` 门禁拒绝某个单元的结果时，[`state.ts`](../../extensions/flow/state.ts) 的 `dependents()` 会传递性地找出所有直接或间接依赖它的下游单元并从 `state.items` 中一并清除，确保状态图中永远不存在基于旧输入算出的孤儿结果。按 `<box>[]` 逐项对应的扇出单元只随同编号路径的上游单元失效，多级扇出逐级如此；多路 `[]` 汇聚的单元只随同 `path` 的上游镜像失效；引用整个扇出盒子结果的单元随任一上游单元失效；被拆单元失效时，它拆出的各部分（以及它们再拆出的部分）随之失效。

### 2.4 14 种日志动作（`Action`）

| Action `kind` | 产生时机 | 状态折叠效果 (`reduce`) |
|---|---|---|
| `defined` | `flow.define(boxes, noEscape?)` 通过校验，且某个盒子的指纹或 `noEscape` 有变化 | 更新或删除 `raw` 与 `boxes`；`noEscape` 省略时保持原值 |
| `supplied` | `flow.supply(name, value)` 值有变化 | 更新 `inputs[name]`，级联删除依赖该输入的下游 `items` |
| `observed` | 宿主检测到外部 Agent 定义或模型设置变化 | 更新 `state.agents` 中的外部哈希标记 |
| `retracted` | `flow.retract(...keys)` | 删除指定输入/单元及其全部传递依赖项 |
| `kept` | `flow.keep(...keys)` | 将指定 `stale` 单元的 `fingerprint` 刷新为当前 `markOf` |
| `retried` | `flow.retry(...keys)` | 将指定 `failed` 单元的 `phase` 改为 `retry` |
| `answered` | `flow.answer(key, value)` | 为处于 `raised` 的单元写入外部答复 `item.answer` |
| `started` / `resumed` | `flow.run()` 通过全部合法性检查 | `mode` 设为 `{ kind: "running" }` |
| `halted` | `flow.stop(reason)` 或进程崩溃重启后 `recover()` | `mode` 设为 `{ kind: "stopped", cause: { kind: "halt", reason } }` |
| `idled` | 调度器发现 `ready` 与 `running` 均为空 | `mode` 从 `running` 设为 `{ kind: "idle" }` |
| `fired` | 调度器启动一个就绪单元 | 创建/更新 `item`，记下本轮 `inputs`，`phase: "running"`，若前态为 `raised` 或 `reopened` 则 `chain + 1`；新的拆分部分记 `depth = 被拆单元的 depth + 1` |
| `spawned` | `task` 或 `fork_task` 工具分配了子代理会话 ID | 记录 `item.session = sessionId` |
| `settled` | 子代理会话或命令执行结束 | 调用 `settle()` 将 `Outcome`（`done`、`raise`、`split`、`rejected`、`failed`、`cancelled`）折叠为最终 `Phase`；`rejected` 把同一路径的全部被检查单元置为 `reopened`，各带自己的交接、门禁输出与这一轮的输入快照（见第 4 节） |

---

## 3. 单次点火契约（Session, Handoff, Whiteboard & Workspace）

### 3.1 严格交回协议（`yieldSchema`）
每个 Agent 盒子的会话通过 `task` 工具派发（拆分部分的首个会话通过 `fork_task` 派发，见 4.1 节）时，固定设置 `schemaMode: "strict"`，其 `outputSchema` 由 [`session.ts`](../../extensions/flow/session.ts) 生成：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "handoff"],
  "properties": {
    "status": { "enum": ["done", "reject?", "raise?", "split?"] },
    "value": { "...": "盒子的 out Schema" },
    "feedback": { "type": "string" },
    "raise": { "enum": ["本会话被提供的 raises 类型"] },
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

`?` 标记的成员按会话的实际能力取舍：`done` 恒有；`reject` 只在盒子声明了 `checks` 时出现，并配 `feedback`；`raise` 只在还有可抛类型时出现，并配 `raise` 与 `detail`；`split` 只在单元的 `depth < box.splits` 时出现。可抛类型是盒子 `raises` 中、该单元还有会话余额（`chain < bound`）的类型；`noEscape` 打开时，还要求流程里有盒子接住该类型，没有下游接住的类型从 schema 与任务书中移除。因此最后一次允许会话没有任何 `raise` 分支。

- 任务书末尾自动追加 `## How to finish` 说明：严禁调用子代理的 `ask` 工具，严禁使用 `yield` 的 `error` 参数，必须通过 `yield({ data: ... })` 提交。带 `checks` 的盒子还会被告知 `reject` 的用法与被检查盒子的名字；被门禁重开的会话还会拿到上一轮的交接、门禁输出的内容，以及门禁那一轮各输入的值（包括同一 `path` 上其他平行盒子的产出）。
- 交回对象里没有各部分：各部分来自编写者批准的拆分请求（见 4.1 节）。
- 由 `interpret()` 判定为 `protocol` 运行时异常的情形：缺少 `handoff`；`status: "done"` 缺少 `value`；`reject` 来自没有 `checks` 的盒子，或 `feedback` 不是非空字符串；`raise` 抛出了盒子未声明、或本会话未被提供的类型；`split` 在 `depth >= box.splits` 的会话里交回，或本会话没有被批准的拆分请求；`status` 不在上述取值内。

### 3.2 单元专属白板文件（Notes file）
- 路径：`<sessionDir>/flow-boards/<encodeURIComponent(item.key)>.md`。
- 同一 `item.key` 的历次会话在任务书中均会收到 `## Notes file` 段落，被告知先读后追加；当该单元抛出问题触发 `<box>!<type>` 答复盒子时，答复盒子的输入对象中也会自动附带 `board: "<path>"`。
- 当单元因 `retract` 或上游重算被移除时，`pruneBoards()` 自动删除对应的白板文件。

### 3.3 隔离工作区继承与 `prepare` 命令
对于 `isolated: true` 的 Agent 盒子，当同一 `item.key` 进行第 $N$ ($N > 1$) 次点火且存在上一次已结束的会话 `earlier: { session, yielded }` 时，[`index.ts`](../../extensions/flow/index.ts) 的 `inheritFrom()` 按以下优先级提取工作区变更：
1. **上一会话正常 `yield` 且宿主已自动合入主检出**（`earlier.yielded && cfgTaskIsolationApply` 且无残留分支）：无需额外 overlay，新 worktree 直接基于已更新的主检出创建。
2. **宿主未能合并而保留的任务分支**（`keptTaskBranch` 存在 `refs/heads/omp/task/<session>`）：调用 `inheritKeptBranch()` 计算 `git diff <merge-base>..<branch>` 作为 overlay 补丁。
3. **宿主释放的补丁文件**（`<sessionDir>/<session>.patch` 存在）：调用 `inheritReleasedPatch()` 读取补丁并校验 `git apply --check`。
4. **仍在存活或未释放的隔离目录**：调用 `inheritSourceWorkspace()` 对比首轮记录的 `recordStart` 基线生成增量补丁。

子代理启动由 `fork_task` 与 `flow` 共用的一个 `before_agent_start` 钩子（[`extensions/fork-task/index.ts`](../../extensions/fork-task/index.ts)）完成，依次执行：
1. `recordStart(file, cwd, id)` 记录当前 worktree 的初始基线；
2. `applyOverlay(file, cwd)` 应用继承的补丁（失败则挂载 `BeforeModelCallHook` 抛错阻止模型运行）；
3. `runPrepare(file, cwd)` 执行盒子留下的 `prepare` 命令（超时 240s，非零退出同样阻止模型运行）。

---

## 4. 业务回路 vs 运行时异常

`flow` 严格区分**业务编排回路（flow loop）**与**运行时异常（runtime exception）**：

| 维度 | 业务回路 1：模型主动抛出 (`raise`) | 业务回路 2：门禁拒绝 (`checks`) | 运行时异常 (`failed`) |
|---|---|---|---|
| **触发条件** | 子代理 `yield` 返回 `status: "raise"` | 带 `checks` 的盒子判定被检查结果不合格：Agent 盒子 `yield` 返回 `status: "reject"` 并给出 `feedback`；Command 盒子以 `rejects` 中的退出码结束 | `spawn` / `workspace` / `session` / `schema` / `protocol` / `bound_exceeded` / `exit`（普通命令非零，或检查命令的退出码不在 `rejects` 中）/ `timeout` / `host` |
| **是否停止整条流** | **否**（其他就绪单元继续运行） | **否**（重开被检查的单元） | 若 `spent < box.handle[name]`（`noEscape` 下 `session`、`timeout`、`protocol`、`schema` 另有默认 1 次）则原地重火；**否则整条流立即 `STOPPED` 并取消所有在跑会话** |
| **下游产物处理** | 尚未产生下游产物 | 先取出该路径上所有被检查单元；再调用 `dependents()` 清除它们此前产出的全部下游结果（含本次门禁单元自身） | 保留已有上游产物，当前单元进入 `failed` |
| **后续如何接回** | `<box>!<type>` 盒子产出结果或外部调用 `flow.answer()` 后，原单元带着 `{ kind: "answer", answer, previous: handoff }` 开新会话 | 每个被检查单元原子置为 `reopened`，下一轮调度带着 `{ kind: "check", check, output, snapshot, previous: handoff }` 开新会话；`snapshot` 是门禁这一轮收到的全部输入（含同一 `path` 上其他平行盒子的产出） | 调用方必须 `define`（修改该盒子定义）、`retract`（撤回）或 `retry`（显式重试）后才允许再次 `flow.run()` |
| **多目标一致性** | 不适用 | 同一 `path` 上的全部被检查单元一起重开，不会只重开一部分 | 不适用 |
| **次数限制** | 计入 `item.chain`；最后一次会话不再提供 `raise`，越权抛出判 `protocol` | 每次重开计入每个被检查单元的 `item.chain`；任一被检查单元已到 `bound` 时不重开任何目标，门禁以 `bound_exceeded` 失败并停流 | 按异常名独立计入 `item.refires[name]`，不消耗 `item.chain` |

### 4.1 拆分（flatMap）

拆分是第三种业务回路，语义是 flatMap：声明了 `splits` 的扇出盒子，其会话判断自己的元素太大、不适合一个会话完成时，先请流程的编写者批准，批准后交回 `{ status: "split", handoff }` 而不是结果。

- **请求与阻塞**：会话调用 `flow_split` 工具，一次调用里给出各部分（每份是替换扇出元素的 JSON 文本）和供编写者判断的详情。该工具只在 `depth < box.splits` 的会话里启用。这次工具调用阻塞到编写者回复为止。
- **送达编写者**：驱动该流程的编写者会话收到一条消息，写明单元键名、会话、详情与各部分；等待期间 `status` 列出 `split asked`。编写者只能回复 `agree`，或 `disagree` 加理由 `reason`。
- **不同意**：工具调用返回编写者的理由，会话在同一会话里继续，可以完成任务，也可以再次请求拆分。
- **同意**：工具调用返回后，会话立即交回 `{ status: "split", handoff }`；交回时被批准的各部分成为单元的 `parts`。
- **原地替换**：被拆单元进入 `split` 阶段，自身不再产出值。每一份 `part` 取代该单元的扇出元素，成为同一盒子的新单元，键名为被拆单元键名加序号（`work#0.0`、`work#0.1`），其余输入原样保留。
- **部分以 fork 开始**：每个部分的首个会话是拆分会话的 fork（`fork_task` 的 `from` 取被拆单元最后一个会话，`workspace: "isolated_from_caller"`，不 shake），继承拆分会话的对话，`continuation` 为 `{ kind: "part", part, of }`，任务书写明自己是第几份。工作区是独立 worktree，从拆分会话交回的改动开始（`earlier` 取被拆单元最后一个会话）。部分在 `depth < box.splits` 时可以继续拆分；部分被门禁重开或答复后续接的会话仍是新会话。
- **没有汇合会话**：盒子的结果就是它的叶子（以结果结束的单元）按编号路径排序的结果。`work[]` 对每个叶子生成一个同编号路径的下游单元，`work` 是叶子结果的数组；归约（reduce）由一个以 `work` 为输入的普通盒子完成。
- **逐叶处理**：门禁按叶子检查，拒绝时只重开该叶子；撤回被拆单元会撤回它的全部部分及其下游，然后被拆单元作为一个整体重新点火。

### 4.2 二级裁决（流内拍板与对外升级）

接住 `<worker>!question` 的盒子（内置 `flow:adjudicator`）为每次抛出生成一个答复单元，它的结果就是答复；worker 带着 `{ kind: "answer", answer, previous: handoff }` 开新会话继续，主会话不介入。

- **流内往返**：裁决盒可以交回 `done`，写明 worker 在还有会话余额时应查清什么；worker 的下一次会话再抛出，裁决盒再次裁决，直到该点被决定或用完 `bound`。
- **对外升级**：裁决盒声明一个没有盒子接住的 `raise`（如 `ask_user`）。只有当本会话的 schema 提供该类型时，它才能交回 `status: "raise"`；流停在裁决单元等候外部 `flow.answer(key, value)`，随后一个裁决会话把答复转成完整工程指令并交回 `done`，worker 继续。
- 没有下游接住的 `raise` 类型在 `noEscape` 下不被提供，裁决盒必须自己决定每一个点。
- 裁决盒不调用 `ask` 工具，也不启动子代理；对外升级只能经结构化 `yield` 发出。

### 4.3 全局封口（`noEscape`）

`noEscape` 用于无人值守运行。`define` 的可选布尔参数打开或关闭它，省略保持原值，只改它而不改盒子也会被接受。打开时：

- `run` 在任一盒子引用的 `input.<name>` 尚未 `supply` 时被拒绝，并列出缺失的输入。
- `session`、`timeout`、`protocol`、`schema` 四类异常在盒子的 `handle` 未点名时额外重火 1 次；`handle` 点名时以它为准；`spawn`、`workspace`、`exit`、`host`、`bound_exceeded` 没有这种保底重试。
- 没有盒子接住的 `raise` 类型从会话 schema 与任务书中移除；一个可抛类型都不剩时会话没有 `raise` 状态，越权抛出判 `protocol`。
- `flow_split` 请求在通过校验（该盒子在此深度可拆、本会话没有待答复或已批准的请求、至少 2 份、每份是合法 JSON）后立即批准，不向编写者发消息；不合法的请求仍带理由拒绝。
- Verdict 多出一行 `noEscape: on`。

---

## 5. `eval` REPL 表面与操作接口

### 5.1 工具层（`tool.flow`）
扩展注册名为 `flow` 的工具（`loadMode: "essential"`），附带三个按需读取的文档主题：
- `help://flow/boxes`：盒子字段、引用语法、门禁检查、裁决与异常说明。
- `help://flow/lifecycle`：12 个操作原语、判定输出格式、停止恢复、过期值处理与拆分请求的答复。
- `help://flow/eval`：在 `eval` JS cell 中调用 `tool.flow` 与加载 `skill://omp-subagent-ng/flow.js` 的方法。

### 5.2 内核辅助层（`flow.js`）
通过 `%load skill://omp-subagent-ng/flow.js` 加载后定义 `globalThis.flow`，自身不保存任何状态：

```js
await flow.define(boxes, opts);    // 登记、覆盖或删除(null)盒子；opts?.noEscape 可选；打印 Verdict
await flow.use(spec, opts);        // 定义一份规格并按序注入其输入；打印每一步的 Verdict
await flow.supply(name, value);    // 注入外部输入 input.<name>；打印 Verdict
await flow.run();                  // 启动或恢复后台驱动 Job；打印 Verdict
await flow.stop(reason);           // 停止运行中的流；打印 Verdict
await flow.status();               // 打印完整接线图(wire)、汇总、下一步提示与所有单元状态
await flow.retract(...keys);       // 撤回输入或单元及其下游；打印 Verdict
await flow.keep(...keys);          // 确认保留过期(stale)单元的值；打印 Verdict
await flow.retry(...keys);         // 允许未改定义的 failed 单元重新点火；打印 Verdict
await flow.answer(key, value);     // 从外部答复未接线的 raise；打印 Verdict
await flow.agree(key);             // 批准该单元会话的拆分请求；打印结果
await flow.disagree(key, reason);  // 拒绝该拆分请求并给出理由；打印结果
const v = await flow.value(key);   // 静默读取 input.<name>、单元或盒子的存储值（不打印）
```

`flow.use(spec, opts)` 接受预设或外置模板返回的规格：

- `spec` 是 `{ boxes, inputs?, noEscape? }`，或直接就是一个纯 `boxes` 映射；
- 先以 `opts?.noEscape ?? spec.noEscape` 执行 `define`，再按 `{ ...spec.inputs, ...opts?.inputs }` 的顺序逐个 `supply`；
- 规格里的盒子与输入都是纯 JSON，不含函数或运行时句柄。

`flow.presets.swarm(options, ...workers)` 生成一份规格（不调用工具）：

- 每个 worker 规格 `{ name, ...box }` 变成一个 `flow:worker` 盒子：默认 `model: options.model`、`out: { type: "object" }`、`isolated: true`，并把 `question` 加入 `raises`；规格里的其余字段（`brief`、`in` 等）照原样保留。
- 每个 worker 另有一个 `<name>_ruling` 裁决盒：`agent: "flow:adjudicator"`，`in.raised: "<name>!question"`，`raises: ["ask_user"]`，`out: { type: "object" }`，`isolated: false`，模型取 `options.rulingModel ?? options.model`；`options.rulingBrief` 可覆盖任务书，`options.request`（一个引用，如 `"input.issue"`）作为裁决盒的 `request` 输入并出现在默认任务书里。
- `options.gate` 生成一个门禁盒（默认名 `gate`）：worker 是扇出盒时取 `<name>[]`，否则取 `<name>`，`checks` 指向全部 worker。
- `options.reduce` 生成一个汇总盒（默认名 `reduce`），取每个 worker 的整体结果。
- `options.inputs` 与 `options.noEscape` 原样带进规格。

`flow.presets.loop(options, ...agents)` 生成一份规格（不调用工具）：

- `options.over` 必须是 `[]` 引用（如 `"input.items[]"`）；每个 agent 都以它为扇出输入（输入名 `options.as`，默认 `"item"`），默认 `flow:worker`、`options.model`、`out: { type: "object" }`，`bound` 取 `options.rounds`。
- `options.check` 必填，生成一个门禁盒（默认名 `check`）：按路径把每个 agent 的 `<name>[]` 配对，`checks` 指向全部 agent，形成多目标反馈回路。
- `options.reduce` 生成一个消费该门禁结果的汇总盒；`options.inputs` 与 `options.noEscape` 原样带进规格。
- 两个预设生成的门禁盒与汇总盒若是 Agent 盒子且未给 `out`，取 `out: { type: "object" }`；Command 盒子不带 `out`。

外置模板是返回同样纯 JSON 规格的函数：从模块导出并用 `await import()` 取得，或在不含 `export` 的脚本里挂到 `globalThis` 上再 `%load` 该脚本。其返回值可直接交给 `flow.use`，也可把多处产出的盒子合并后交给 `flow.use` / `flow.define`：

```js
const loop = flow.presets.loop(
  { over: "input.items[]", model: "task:low", rounds: 2, inputs: { items },
    check: { agent: "flow:guardian", model: "task:low", brief: "Judge {{red}} against {{blue}}", out: { type: "object" } } },
  { name: "red", brief: "Attack {{item}}" },
  { name: "blue", brief: "Defend {{item}}" },
);
const { review } = await import("./templates/review.js");
await flow.use({ ...loop, boxes: { ...loop.boxes, ...review().boxes } });
```

合并按对象展开进行：同名盒子由后展开的一方覆盖，`inputs` 与 `noEscape` 也按同样方式自行合并。

### 5.3 判定输出格式（Verdict）
每次除 `value` 外的调用均返回并由 `flow.js` 隐式 `print` 以下结构的文本（[`report.ts`](../../extensions/flow/report.ts)）：
1. **状态头行**：`flow running | complete | not running | STOPPED · X done · Y running · Z raised · W failed · V cancelled`；有被拆单元时在 `done` 之后多出 `N split`；`noEscape` 打开时下一行是 `noEscape: on`
2. **停止原因与阻断项**（按需出现）：`cause: ...`、`problem: ...`、`needs: ...`、`waiting for inputs: ...`、`unpaired: ...`、`stale: ...`、`illegal: ...`、`raised and unanswered: ...`；`unpaired` 形如 `unpaired: review#2 (nothing at this path from a, b)`
3. **合法下一步提示**：`next: supply issue | keep or retract work#0 | run | stop`（由 [`store.ts`](../../extensions/flow/store.ts) 的 `moves(state)` 直接调用与 `judge` 相同的判定逻辑生成，保证列出的操作 100% 会被接受）。
4. **接线图**（仅 `status` 输出）：`wire work ← input.slices[] · raises question → answer · splits 1 deep · fires again on session ×1`；Command 门禁写作 `wire check ← work[] · exit 1 reopens work`，Agent 门禁写作 `wire review ← work[] · reject reopens work`；没有盒子接住的抛出写作 `raises ask_user → an answer from outside`。
5. **状态增量（Delta）**：自上次 Verdict 以来新增（`+`）、变更（`~`）或移除（`-`）的盒子、输入与单元行。
