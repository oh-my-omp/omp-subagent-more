# `flow` 编排原语：现状盘点与后续推进路线图

本文档回答**“现在做到了哪一步、哪些是业务试验留下的噪音、接下来怎么继续把这个原语做完并转正”**。

---

## 1. 现有代码盘点（[`prototype/flow/`](../../prototype/flow/)）

核心引擎已经实现并通过了 46 项专项单测（[`tests/flow-store.test.ts`](../../tests/flow-store.test.ts)）与真机端到端验证：

| 文件 | 职责 | 状态 |
|---|---|---|
| [`prototype/flow/defs.ts`](../../prototype/flow/defs.ts) | `AgentBox` / `CommandBox` 解析、四种 `Ref` 引用解析、`{{name}}` 模板填充与 `shellWord` 转义、稳定 JSON 指纹计算 | 已完成 |
| [`prototype/flow/state.ts`](../../prototype/flow/state.ts) | 不可变 `State`、`Item`、`Phase`、`Action` 定义，纯函数 `reduce`、`settle`、`dependents` 级联失效与 `replay` | 已完成（有 1 处粒度缺陷见 E2） |
| [`prototype/flow/plan.ts`](../../prototype/flow/plan.ts) | 静态定义检查 `lint`、动态单元展开 `expandBox`、状态推导 `survey`（计算 `ready`/`stale`/`illegal`/`raised`/`needs`/`waiting`） | 已完成 |
| [`prototype/flow/store.ts`](../../prototype/flow/store.ts) | 唯一写入者 `Store`、命令合法性裁判 `judge`、合法下一步生成器 `moves`、进程重启恢复 `recover` | 已完成 |
| [`prototype/flow/session.ts`](../../prototype/flow/session.ts) | 子代理任务书拼装 `briefOf`（含 `Earlier work`、`Notes file`、`Continuation`、`How to finish`）、`yieldSchema` 生成与结果解析 `interpret` | 已完成 |
| [`prototype/flow/report.ts`](../../prototype/flow/report.ts) | Verdict 文本渲染：`headline`、`wiring` 接线图、`marksOf` 与 `delta`（`+ / ~ / -` 增量输出） | 已完成 |
| [`prototype/flow/journal.ts`](../../prototype/flow/journal.ts) | `flow.jsonl` 磁盘读写与类型校验，自动丢弃因崩溃截断的最后一行 | 已完成 |
| [`prototype/flow/host.ts`](../../prototype/flow/host.ts) | OMP 扩展入口：注册 `flow` 工具、后台单 `AsyncJob` 驱动循环、`TaskTool` 派发与 `acknowledgeDeliveries`、工作区继承与 `prepare` 钩子 | 已完成（有 3 处工程问题见 E1/E3） |
| [`prototype/flow/docs.ts`](../../prototype/flow/docs.ts) | `flow` 工具描述与 `help://flow/{boxes,lifecycle,eval}` 三个文档主题 | 已完成 |
| [`prototype/flow/helper.js`](../../prototype/flow/helper.js) | `eval` 内核 `%load` 辅助脚本：定义 `globalThis.flow`，自动序列化 JSON、隐式 `print` 判定、被拒时抛错 | 已完成 |
| [`prototype/flow/inherit.ts`](../../prototype/flow/inherit.ts) | `flow` 专用的工作区继承：`inheritReleasedPatch`、`keptTaskBranch`、`inheritKeptBranch`，复用 `extensions/fork-task/workspace.ts` 的 `gitApply` | 已完成（单测见 [`tests/workspace.test.ts`](../../tests/workspace.test.ts)） |

---

## 2. 仓库中混入的业务试验品噪音（清理清单）

由于上个会话把“编排原语设计”与“业务 Issue 编排方案”混在了一起，以下文件包含大量业务试验特定内容，推进原语时应予以剥离或重写：

1. **[`research/lowcost/`](../../research/lowcost/)（共 60 个文件）**：
   - 全部是针对 `omp-config` `#320/#321/#322` 的试跑脚本（`loop.js`, `flow.js`, `flow-323.js`）、25 个 Issue 侦察 JSON 和业务排程方案 `PLAN.md`。它们只是催生 `flow` 原语的早期试验脚手架，**与 `omp-subagent-more` 插件本身无关**。
2. **[`research/flow/BASELINE.md`](../../research/flow/BASELINE.md)**：
   - 混杂了大量业务规则（如“中等及以下拆给 free/low/mid”、“swe2 并发限流”、“carbon 已禁用”）。其中属于编排原语的通用设计基线已提取至本目录的 [`README.md`](./README.md)。
3. **[`prototype/flow/agents/flow-*.md`](../../prototype/flow/agents/)（5 个角色文件）**：
   - `flow-scout.md`、`flow-adjudicator.md`、`flow-worker.md`、`flow-guardian.md`、`flow-verifier.md` 中硬编码了大量特定于你个人仓库工作流的规则（例如“不要修改 `CHANGELOG.md`”、“编辑前必须调 `todo` 工具建列表但绝不能勾选完成”、“使用 `ast_grep`”）。如果保留为插件内置角色，必须剥离这些业务特定规则（见 O3）。

---

## 3. 待拍板的 4 个核心设计问题（Open Design Decisions）

在继续写代码前，需要先定下以下 4 个设计决策：

### O1. `checks` 门禁命令的“业务拒绝 vs 命令异常”边界怎么划？
- **现状**：[`host.ts`](../../prototype/flow/host.ts) 的 `runCommand()` 将带有 `checks` 的命令盒子退出码 `1–125` 全部判为 `rejected`（不记异常，直接重开被检查的 Agent 单元），仅 `126+` 判为 `exit` 运行时异常停流。
- **问题**：shell 中测试脚本路径不存在（`bun` 退出码 `1`）、命令语法错误（退出码 `2`）、`timeout` 超时（退出码 `124`）全在 `1–125` 内。这会导致**门禁命令自身写错或环境故障时，不报错停流，而是把报错发给 Agent 让它重开会话去“修代码”**，白白浪费 `bound` 次数和模型费用。
- **可选方案**：
  - **方案 A**：命令盒子增加可选字段或约定，仅特定退出码（如默认仅退出码 `1`，或约定一个专用退出码/输出标记）代表“业务门禁拒绝”，其余非零退出码一律按 `exit` 运行时异常停流。
  - **方案 B**：保持当前 `1–125` 规则不变，由写流程的人自行保证门禁命令可执行。

### O2. 是否需要支持“自循环动态展开”（`flatMap` 推回自身队列）？
- **现状**：[`defs.ts`](../../prototype/flow/defs.ts) 支持跨盒子的单层数组扇出（`scout` 产出 `slices[]` → 展开为 `work#0`, `work#1`），但 [`plan.ts`](../../prototype/flow/plan.ts) 禁止任何盒子引用成环，且每个盒子最多只能有一个 `multi` 输入。
- **问题**：你在基线中提到过*“乃至 issue 本身都可以动态拆分，实际上，agent 的返回值可能可以用于 flatMap”*。如果只需要“上游 `scout` 拆切片交给下游 `work`”，现有单层扇出已经够用；如果需要“`work#0` 做到一半发现任务太大，交回 `subSlices[]` 继续作为 `work#0.0`, `work#0.1` 执行”，则需要给 `AgentBox` 增加树状自展开机制（或一种新的 `expand` 交回状态）。

### O3. 5 个定制角色（`flow:scout / adjudicator / worker / guardian / verifier`）的定位是什么？
- **可选方案**：
  - **方案 A（只做纯粹的原语引擎）**：`omp-subagent-more` 不内置业务角色，或仅提供通用无业务规则的极简角色底座（只写“你是只读侦察者/裁决者/实现者，通过 `yield` 交回结构化数据，禁止调 `ask` 和派子代理”），具体项目规则由用户在盒子的 `brief` 里传入或由项目自己的 `.omp/agents/` 定义。
  - **方案 B（随插件发布这 5 个角色）**：把 `prototype/flow/agents/flow-*.md` 移入顶层 `agents/` 随插件发布，但清理掉其中关于 `CHANGELOG.md`、`todo` 不打勾等耦合特定仓库的语句。

### O4. `eval` 中如何加载 `flow` 辅助函数？
- **现状**：需要先在一个 cell 里运行 `%load <path>/helper.js`（正式发布后为 `%load skill://omp-subagent-more/flow.js` 或 `orchestrate.js`），或者直接调裸桥接 `await tool.flow({ op: ... })`。
- **决策**：是否用新的 `flow` 辅助脚本直接替换现有的 `skill://omp-subagent-more/orchestrate.js`？

---

## 4. 转正发布前必须完成的 4 项工程修复（Engineering Tasks）

一旦上述设计问题拍板，将 `prototype/flow/` 转正为 `omp-subagent-more` 正式功能只需完成以下 4 个明确步骤：

### E1. 加固隔离会话的合入失败检测（[`host.ts`](../../prototype/flow/host.ts) 的 `handBackFailure()`）
- **现状**：`handBackFailure()` 仅靠解析 `job.resultText` 中的 `<merge-summary>` 和 `&lt;system-notification>` 字符串判断 OMP 是否未能合入隔离子代理的改动。
- **修复**：除保留文本检查外，在 `spawnAndWait` 结束且 `box.isolated === true` 时，直接调用 `await keptTaskBranch(session, parent.sessionManager.getCwd())` 检查宿主是否留下了未合并的 `omp/task/<session>` 分支。只要该分支存在，即可确定分支合并失败，不再单纯依赖宿主渲染文案。

### E2. 修复扇出单元的级联失效粒度（[`state.ts`](../../prototype/flow/state.ts) 的 `dependents()`）
- **现状**：`dependents()` 判断两个扇出盒子是否按索引 `1:1` 镜像时写了 `const mirrored = ref.multi && ref.path.length === 0 && parts.index !== undefined && isFanned(state.boxes[ref.source.box])`。
  - 如果下游盒子写的是 `in: { x: "work.output[]" }`（`ref.path` 非空），或者存在多级扇出，当 `work#1` 被门禁重开或撤回时，`mirrored` 为 `false`，会退化为 `goneBoxes.has("work")`，导致已完成且无关的 `work#0` 的下游单元也被连坐清除。
- **修复**：凡是 `parts.index !== undefined && isFanned(state.boxes[ref.source.box])` 且引用源为该扇出盒子的逐项输入，均按相同 `index`（`itemKey(ref.source.box, parts.index)`）精确匹配失效，而非整盒连坐。

### E3. 与 [`extensions/fork-task/index.ts`](../../extensions/fork-task/index.ts) 合并生命周期钩子
- **现状**：`extensions/fork-task/index.ts` 和 `prototype/flow/host.ts` 各自注册了 `before_subagent_spawn` 和 `before_agent_start`，且都在 `before_agent_start` 中对每个子代理执行 `recordStart(file, cwd, id)` 和 `applyOverlay(file, cwd)`。如果同时加载两个入口，`applyOverlay` 会在第一个钩子中消费并删除 `.patch` 文件，导致第二个钩子或后续逻辑状态不一致。
- **修复**：将 `flow` 工具的注册与 `beforeSubagentSpawn` / `prepareWorkspace` 逻辑接入 `extensions/fork-task/`（或抽出统一的插件入口），让 `fork_task` 与 `flow` 共用同一次 `recordStart` 和 `applyOverlay`。

### E4. 迁移目录、更新文档与导出配置
1. 将 `prototype/flow/` 移入 `extensions/flow/`（并在 `package.json` 的 `omp.extensions` 中加载，或由统一入口加载），`tests/workspace.test.ts` 中 `keptTaskBranch`、`inheritKeptBranch` 的导入随 `inherit.ts` 一起迁移。
2. 用 `prototype/flow/helper.js` 替换 `skills/omp-subagent-more/orchestrate.js`，并更新 `skills/omp-subagent-more/SKILL.md`、`README.md`、`README.zh-CN.md`。
3. 更新 `tsconfig.json`、`biome.json` 与 `tests/flow-store.test.ts` 的导入路径，清理不再需要的 `orchestrate.test.ts`（或保留兼容层）。
