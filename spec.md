# NetBox SRE Agent 完备 Spec v2（真 Tool-Calling 闭环 + 可视化 + 回归测试 + 收敛护栏）

> v2 变更：合入 review 的 P0/P1 修正（内置工具隔离、fixture 工作副本、变异测试、YAML 依赖、compose 形态、验收阈值）；新增 R7 回归测试、R8 收敛护栏、R9 故障域覆盖矩阵；新增 §3 核心数据契约、§7 故障判别机制（确定性签名库 + LLM 裁决）。

## 1. 背景与定性

- **分析对象**：`/Users/gloria/cre_improve/netbox-docker`（已克隆，VERSION=5.1.0，镜像 tag `v4.7-5.1.0` = NetBox v4.7 + 支撑文件 5.1.0）。「基础设施即代码/部署配置」仓库：Dockerfile + compose 五服务（netbox / netbox-worker / postgres / redis / redis-cache）+ 配置模板层（`configuration/configuration.py` 从环境变量读配置、`env/*.env` 注入、`docker-compose.override.yml` 为官方非侵入定制入口、`_read_secret()` 支持 Docker secrets）。
- **两层观测面**：L1 静态面 = 仓库文件的「应然」（拓扑/基线）；L2 运行面 = compose 栈的「实然」（状态/日志/探活）。诊断本质 = 实然偏离应然时用应然知识定位根因。
- **工作副本（fixture）机制**：Agent 的实际工作对象是每次 run 从原仓库复制到临时目录的 **fixture 副本**（`traces/<run-id>/fixture/`），不是用户克隆的原仓库。理由：① 处置动作（写 override）不污染原仓库；② 变异测试可任意改 fixture；③ 天然可重入。原仓库始终是只读「数据来源」。
- **可视化生态调研**：pi 生态有四层——SDK 原生事件流（`session.subscribe`，官方示例用途即「Build a custom UI」）、`pi-web-ui`（浏览器驾驶舱，进程内跑 pi SDK、WebSocket 推流、tool-call 卡片实时状态、插件系统）、`pi-agent-dashboard`（多会话运维监控台，Electron/隧道重依赖）、SDK 自带 `InteractiveMode`（TUI）。采用 V1 自研轻量仪表盘（必做）+ V2 pi-web-ui（可选）；不采用 pi-agent-dashboard。

## 2. 需求基准（R0–R9）

- **R0 总纲**：交付真 Tool-Calling SRE Agent，以 netbox-docker 为唯一数据来源与分析对象，自主完成「发现异常→诊断根因→执行处置→验证恢复」闭环。
- **R1 结构标准**（验收锚点）：① 工具是唯一能力边界，全部带 JSON-Schema 参数契约（对齐 pi SDK `defineTool`）；② 决策与执行分离；③ 观察反馈回环（ReAct）；④ **非剧本化，必须以变异测试证明**（见 R7-3）；⑤ 工具失败时 Agent 能调整策略而非崩溃（必须有验收条目）。
- **R2 数据来源**：L1 = compose/env/configuration.py；L2 = 容器状态/healthcheck/日志/HTTP 探活。所有观测统一为可回溯 Finding（契约见 §3）。
- **R3 异常目录**：静态 14 条规则 + 运行时 9 个故障剧本（覆盖矩阵见 §6）。
- **R4 闭环与验收**：四步循环 + 轨迹日志可回答「Agent 自主编排了哪四步、每步调了什么工具、依据什么观察」。
- **R5 实现约束**：直接绑定 pi SDK（`@earendil-works/pi-coding-agent`）；API Key 用户提供（默认 anthropic/claude，model ID 与 thinkingLevel 见 §8）；Phase 2 容器运行时用 colima（不用 Docker Desktop）；**compose 调用统一走 standalone `docker-compose` 二进制**（本机探测确认 compose plugin 不存在，colima 也不提供），`env-check` 输出可用形态供 runtime-tools 选择。
- **R6 可视化**：必须有可视化界面，数据来自真实事件流与轨迹工件，不允许事后伪造。V1 必做（live + replay）；V2 可选（pi-web-ui）。
- **R7 回归测试**（新增）：测试分四层——① 单元层（确定性，零 LLM 零 Docker）；② 契约层（Agent 结构断言，零 LLM）；③ 回放层（用录制 trace，零 LLM）；④ 闭环层（需 LLM，手动/nightly）。①②③ 必须进 CI 且秒级完成；④ 标注为昂贵测试。**核心手段：录制-回放分离，把昂贵 LLM 测试与廉价确定性测试解耦。**
- **R8 收敛与防发散**（新增）：执行过程必须可控收敛，机制见 §8（软阶段门 / 预算护栏 / 重复检测 / 客观收敛判据 / 作用域锁定 / 收敛度可观测）。**「不发散」必须是可观测指标与可验收断言，不是主观印象。**
- **R9 故障域覆盖**（新增）：运行时剧本必须覆盖 ≥7 个故障域，且**每个剧本考验一条不同的诊断路径**（强制不同工具组合、根因落在不同层）。不追求穷尽真实故障空间；资源类（磁盘满/OOM）为 P2 可选。

## 3. 核心数据契约（新增章节）

**Finding**（L1/L2 统一观测单元）：
```
{ id, rule_id|signature_id, severity: CRITICAL|HIGH|MEDIUM|LOW|INFO,
  layer: "static"|"runtime",
  source: {file, line, value} | {container, timestamp, stream},
  observed, expected, evidence,          // evidence = 可回溯原文片段
  auto_fixable: bool, fix_hint,
  status: "open"|"fixed"|"advisory"|"false_positive" }
```

**ToolEvent**（trace.jsonl 每行，验收与回放的事实源）：
```
{ ts, run_id, seq, type: "tool_start"|"tool_end"|"tool_error"|"text_delta"|"agent_end",
  tool_name, args_summary, status: "running"|"finished"|"error",
  duration_ms, result_summary, error?, phase_hint }
```
约束：`tool_start`/`tool_end` 必须配对；耗时以 trace 为唯一事实源（UI 不得独立断言耗时）。

**Signature**（运行时故障签名，确定性判别的基础）：
```
{ id, fault_domain, applies_to: "log"|"status"|"probe"|"inspect",
  pattern (正则/状态谓词), root_cause_layer: "credential"|"network"|"dependency"|"app_config"|"version"|"migration"|"orchestration"|"resource",
  confidence, next_probe_hint, remediation_hint }
```

**report.md 四段模板**（验收④的机械检查依据）：
```
## 1. 发现清单      —— Finding 表（id/severity/layer/source/status）
## 2. 根因与依据    —— 每条根因必须绑定证据（file:line 或 container+log 行）
## 3. 已执行动作    —— 工具名 + 参数 + 产物路径 + 时间戳
## 4. 验证结果与遗留风险 —— verify 的 before/after；未修复项 + 建议
```

**rule 与 finding 的计数语义**：规则是静态定义（14 条），finding 是实例（一条规则可命中多处，如 SECRET-003 覆盖 redis + redis-cache → 2 个实例）。验收与 UI 一律以 **finding 实例数**为准，规则数仅用于知识库完整性检查。

## 4. 总体架构

```
netbox-sre-agent/
├── package.json          # deps: @earendil-works/pi-coding-agent, js-yaml（唯一 YAML 依赖）
├── README.md             # 真 Tool-Calling Agent 定义、pi 可视化生态取舍、演示与测试指南
├── src/
│   ├── run-agent.mjs     # 入口：env-check→建 fixture→createAgentSession→prompt→报告；--ui 并行起仪表盘
│   ├── events/bus.mjs    # session.subscribe → fanout（recorder / dashboard SSE / report）
│   ├── tools/
│   │   ├── core.mjs      # 工具纯实现（name+schema+execute），与注册形态解耦
│   │   ├── registry.mjs  # 汇总 + defineTool() 包装 → customTools 数组与工具名白名单
│   │   ├── static-tools.mjs / runtime-tools.mjs   # 按层组织 core 实现
│   ├── knowledge/
│   │   ├── rules.mjs     # 静态 14 条规则
│   │   └── signatures.mjs# 运行时故障签名库（确定性判别）
│   ├── trace/recorder.mjs# trace.jsonl + trace.md + report.md
│   ├── guard/budget.mjs  # R8 收敛护栏：预算计数、重复检测、收敛度指标
│   ├── prompts/system.md # 系统提示词全文（角色/流程/边界/收敛判据/输出格式）
│   └── dashboard/{server.mjs, public/index.html}   # node:http + SSE，端口 9377（前端零依赖）
├── harness/              # 演示驱动器（非 Agent 工具）
│   └── fault-driver.mjs  # fault_inject / cleanup 的实现，由 harness 调用，不暴露给 Agent
├── tests/
│   ├── unit/             # R7-①：scanner/签名库/override 生成/路径防护/schema 校验
│   ├── contract/         # R7-②：工具集断言、事件 fanout、trace schema
│   ├── replay/           # R7-③：录制 trace 回放（仪表盘一致性、report 确定性）
│   └── e2e/              # R7-④：变异测试 + 剧本端到端（需 LLM，手动/nightly）
├── traces/<run-id>/      # trace.jsonl / trace.md / report.md / fixture/ / recordings/
└── pi-extension/netbox-sre-tools.mjs   # V2 可选：pi.registerTool() 包装同一 core
```

- **事件流拓扑**：`session.subscribe` → 事件总线 fanout → { recorder、dashboard SSE、report、guard }。UI 永远是事件流投影。
- **工具隔离（P0 修正，R1-① 的硬保障）**：`createAgentSession({ tools: [<仅 13 个自定义工具名>], noTools: "builtin", customTools, ... })`。pi SDK 默认启用内置 `read/bash/edit/write`——**若不禁用，Agent 可用 bash 绕过全部领域工具**，导致闭环链验收与阶段推导失效。必须双保险（白名单 + `noTools:"builtin"`），并以契约测试断言 `session.agent.state.tools` 名称集合 == 自定义工具集合。
- **会话管理**：`SessionManager.inMemory()`（零副作用，不写 `~/.pi/agent/sessions`）；取舍：放弃 pi 原生 resume/分支能力，换取可复现与无残留。
- **环境能力自适应**：无 Docker daemon 时 L2 工具返回结构化错误 + 准备指引，Agent 自主降级 L1（R1-⑤ 的真实考验，有对应验收）。
- **依赖声明**：运行时依赖仅 `@earendil-works/pi-coding-agent` + `js-yaml`（override 的解析与合并必须用库，手写 YAML 解析不可接受）；**「零第三方依赖」的表述仅适用于 dashboard 前端层**（原生 HTML/JS，无框架无构建）。

## 5. 工具契约

**Phase 1（L1 静态，6 个）**
| 工具 | 参数 | 返回 | 角色 |
|---|---|---|---|
| `repo_scan` | `{scope}` | Finding[]（static）+ repo 摘要（VERSION/镜像 tag/服务清单） | 发现 |
| `rule_explain` | `{rule_id}` | 机理、影响面、修复路径、`auto_fixable`、`fix_hint` | 诊断知识 |
| `file_read` | `{path, start_line?, end_line?}` | 文件内容（**path.resolve 后校验前缀在 fixture 根内，拒绝 `../` 逃逸**） | 取证 |
| `override_generate` | `{fixes:[{rule_id}], reason}` | 用 js-yaml 读取已有 override 并合并 environment 段（幂等：同输入两次结果字节一致），返回写入片段；密钥类返回「不可自动修复 + 理由 + secrets 迁移建议」 | 处置 |
| `config_verify` | `{}` | 复扫全部规则，输出 before/after（消除/仍在/仅建议） | 验证 |
| `fault_classify` | `{evidence}` | **候选根因列表**（命中 signature + 证据行 + 置信度 + `next_probe_hint`），刻意不返回最终结论 | 诊断裁决辅助 |

**Phase 2（L2 运行态，6 个；`fault_inject` 移出 Agent 工具集）**
| 工具 | 参数 | 返回 | 角色 |
|---|---|---|---|
| `stack_status` | `{}` | 五服务状态 + healthcheck 详情 + `State.OOMKilled`/重启次数（`docker-compose ps` + `docker inspect`） | 发现 |
| `container_logs` | `{service, tail?, since?}` | 日志文本 **+ 内联 `signature_hits`**（采集时顺带做确定性签名匹配） | 取证 |
| `http_probe` | `{path}` | 状态码/耗时/响应片段（`/login/`、`/api/status/`、`/metrics`；用外部 IP 与 localhost 双探以暴露 ALLOWED_HOSTS 类故障） | 取证 |
| `stack_reapply` | `{}` | 重载修正后的 compose | 处置 |
| `service_restart` | `{service}` | 重启指定服务 | 处置 |
| `health_verify` | `{}` | 全栈复探 + **确定性恢复判定**（不由 LLM 宣布恢复） | 验证 |

- **`fault_inject` 归属修正**：它是 **harness（`harness/fault-driver.mjs`）的职责，不暴露给 Agent**。否则会出现「Agent 自己注入故障再自己修」的自导自演，削弱可信度。Agent 的任务从「栈已处于某状态」开始，自己 probe 才知道有无异常。
- **compose 形态**：所有 compose 调用统一走 standalone `docker-compose`（`env-check` 探测并输出可用形态，runtime-tools 据此选择命令）。

## 6. 异常目录

### 6.1 静态规则（14 条）
- SECRET：`SECRET-001` SECRET_KEY 明文（CRITICAL，不可 auto_fix）、`SECRET-002` DB_PASSWORD 明文（CRITICAL，同）、`SECRET-003` REDIS/REDIS_CACHE 密码明文（HIGH，同，**2 个 finding 实例**）、`SECRET-004` API_TOKEN_PEPPER 明文（HIGH，同）。知识库须如实标注「上游出厂演示值」前提，风险表述为「生产沿用明文/默认密钥即构成风险，且 `_read_secret()` 已提供安全路径却未使用」。
- NET：`NET-001` CORS_ORIGIN_ALLOW_ALL=True（HIGH，**auto_fixable**）、`NET-002` ALLOWED_HOSTS 缺省 `*`（MEDIUM，需用户域名，默认不修）、`NET-003` SECURE_SSL_REDIRECT=False（MEDIUM，auto_fixable）、`NET-004` HSTS 未启用（MEDIUM，auto_fixable）、`NET-005` DB_SSLMODE=prefer（MEDIUM，auto_fixable→require）、`NET-006` REDIS*_SSL=false（MEDIUM，auto_fixable）。
- OBS：`OBS-001` METRICS_ENABLED=false（MEDIUM，auto_fixable）、`OBS-002` EMAIL 空+明文（LOW，不可 auto_fix）。
- OPS：`OPS-001` SKIP_SUPERUSER=true（INFO）、`OPS-002` redis 持久化配置不一致（INFO）。

### 6.2 运行时故障域覆盖矩阵（9 剧本，R9）

| 剧本 | 故障域 | 注入方式 | 必需观测面 | 根因层 | 考验的诊断能力 |
|---|---|---|---|---|---|
| `db_auth_mismatch` | 凭据 | fixture 写错 DB_PASSWORD | logs | credential | 日志签名 → env 配置回溯 |
| `redis_auth_mismatch` | 凭据 | 写错 REDIS_PASSWORD | logs+status | credential | 级联不健康的归因（谁先坏） |
| `db_host_unresolvable` | 网络 | 写错 DB_HOST | logs | network | 区分「认证失败」vs「名字解析失败」 |
| `dependency_killed` | 依赖可用性 | `stop postgres` | status+probe | dependency | 拓扑推理（compose depends_on） |
| `cache_offline` | 依赖降级 | `stop redis-cache` | logs+probe | dependency | 区分「致命」vs「降级可用」 |
| `allowed_hosts_reject` | 应用配置 | 设 ALLOWED_HOSTS 为不匹配值 | **probe（必需）** | app_config | **healthcheck 健康但外部 400 —— 单看 compose ps 必然漏诊**（依据 `configuration.py:64-67` 强制加 localhost 的真实逻辑） |
| `secret_key_invalid` | 应用配置 | 置空/截短 SECRET_KEY | logs | app_config | 启动即失败 vs 运行中失败的区分 |
| `image_version_mismatch` | 版本兼容 | compose tag 与 VERSION 不同步 | status+logs+**file_read** | version | **L1↔L2 跨层关联推理**（tag ↔ VERSION 文件 ↔ 容器行为） |
| `healthcheck_start_period` | 编排参数 | start_period 调至 5s | status+logs | orchestration | **不误诊**：正确答案是编排参数问题，处置=调 start_period 而非重启 |
| （P2 可选）`disk_full` / `oom_killed` | 资源 | 填充 volume / 限内存 | inspect+logs | resource | 资源类根因 |

**覆盖度评估（诚实结论）**：9 剧本覆盖 8 个故障域（凭据/网络/依赖可用性/依赖降级/应用配置/版本兼容/编排参数，+P2 资源）。**不追求穷尽**（真实故障空间无限），追求的是每个剧本强制一条不同的诊断路径——这才是「Agent 真在推理」的证据。Phase 2 必做前 5 个 + `allowed_hosts_reject` + `healthcheck_start_period`（共 7 个），`image_version_mismatch`/`secret_key_invalid` 为 Phase 2 内可选，资源类 P2。

### 6.3 主要故障签名（signatures.mjs 基准，均可单元测试）
`password authentication failed for user` → credential；`WRONGPASS invalid username-password pair` → credential；`could not translate host name .* to address` → network；`DisallowedHost` / `Invalid HTTP_HOST header` → app_config；`SECRET_KEY` + `at least 50 characters` / `ImproperlyConfigured` → app_config；`❌ Waited .* for the DB to become ready` → dependency（entrypoint 原文）；`django.db.migrations.exceptions` → migration；`OOMKilled=true` → resource；`No space left on device` → resource；healthcheck 失败 + 迁移日志仍在进行 → orchestration(start_period)。

## 7. 故障判别机制（确定性签名库 + LLM 裁决）

**明确回答「故障区分是否依赖 LLM」：不是纯 LLM 依赖。**分工如下：

| 环节 | 承担者 | 理由 |
|---|---|---|
| 故障**检测** | 工具确定性采集 | 纯观测，无判断 |
| **签名匹配** | `signatures.mjs` 确定性规则 | 可复现、可单元测试、抗幻觉 |
| 候选**裁决 + 跨层关联** | LLM | 多签名命中时的选择、L2 现象 ↔ L1 配置证据的关联，这是真需要推理处 |
| 签名**未命中**时的开放推理 | LLM 兜底 | 保留泛化能力 |
| 恢复**判定** | `health_verify` 确定性断言 | 不允许 LLM 自行宣布修好 |

`fault_classify` 返回候选（含证据行与置信度）而非结论，确保诊断不退化为查表，同时让 LLM 的每个结论都必须绑定到具体证据行。

## 8. Agent 循环、收敛护栏与防发散（R8）

- **驱动**：`session.prompt(任务指令)`，循环由 pi SDK 内部推进。Phase 1 指令 =「对 fixture 做配置巡检，选出**你能修复的最高优先级一项**完成处置并验证，其余仅给建议」；Phase 2 指令 =「对当前运行的栈做健康巡检，**如有异常**则诊断并恢复，输出根因」（**不预设一定有故障**，Agent 必须先 probe）。
- **模型**：默认 `anthropic/claude-*`（具体 ID 在 env-check 输出可用列表后选定，默认取 sonnet 档以控成本），`thinkingLevel: "medium"`，均可环境变量覆盖。
- **六层收敛机制**：
  1. **软阶段门**：工具返回附带 `next_hints`（基于当前观测状态的候选下一步）——**引导而非硬拒绝**，不违反 R1-④ 非剧本化；
  2. **预算护栏**：max turns 25 / max tool calls 40 / 单工具超时（L1 5s、L2 30s）/ 总时长 10min / token 成本上限；超限**终止并输出「未完成 + 已完成部分」报告**，绝不静默烧钱；
  3. **重复检测**：同工具 + 同参数连续 ≥3 次 → 注入系统提示「已重复该操作，请改变策略或结束」；
  4. **客观收敛判据**：`config_verify`/`health_verify` 返回通过 + report 四段齐全 = 闭环完成，提示词要求满足即停止；
  5. **作用域锁定**：指令限定只处置一项，其余仅建议（发散的主要来源是试图修全部）；
  6. **收敛度可观测**：guard 在 trace 中记录并供仪表盘展示——工具调用总数、重复调用次数、阶段回退次数、预算消耗百分比。
- **验收断言（可机械检查）**：工具调用总数 ≤15、重复调用 ≤1、阶段回退 ≤1、预算未超限。

## 9. 可视化层（R6）

- **数据契约**：UI 只消费 live SSE 流或 trace.jsonl（replay），**两者共用同一渲染代码路径**（一致性可验证）。
- **V1 SRE 闭环仪表盘（必做，Phase 1）**：`node:http` + SSE + 单文件原生 HTML/JS（前端零依赖、无构建），端口 9377（占用时自动 +1 并在输出中打印实际端口）。五面板：① 闭环阶段进度（由工具序列推导）；② 工具调用时间线（名称/参数摘要/状态/耗时，与 ToolEvent 一一对应）；③ Findings 表（severity 着色、layer 分区 static/runtime、status 标记）；④ **收敛度面板**（R8 指标）；⑤ report.md 渲染。启动：`npm run demo:static -- --ui` / `npm run replay -- traces/<run-id>/trace.jsonl`。
- **V2 pi-web-ui（可选，Phase 2）**：同一 core 以 `pi.registerTool()` 注册为 `.pi/extensions/netbox-sre-tools.mjs`，`npx pi-web-ui --cwd <工作区>`。**准确定位：这是「同一套工具 + 同一系统提示词，由 pi-web-ui 自己的 in-process 会话驱动」的另一条运行路径，不是 V1 同一个 run 的另一种视图**（pi-web-ui 自建会话，我们的 run-agent 不参与）。非闭环验收必需。
- README 记录生态取舍（不采用 pi-agent-dashboard 的理由）。

## 10. 回归测试策略（R7）

| 层 | 需 LLM | 需 Docker | 内容 | 进 CI |
|---|---|---|---|---|
| ① 单元 | 否 | 否 | scanner：fixture → 期望 finding 集合（14 规则全覆盖 + auto_fixable 标志）；签名库：每个 signature ≥1 正例 +1 反例；override_generate：幂等性（两次字节一致）+ 合并正确性；config_verify 差异；路径穿越防护（`../` 被拒）；每个工具的参数 schema 非法输入 → 结构化错误而非崩溃 | 是（秒级） |
| ② 契约 | 否 | 否 | **`session.agent.state.tools` == 自定义工具集（无内置 read/bash/edit/write）**；事件总线 fanout 完整（recorder/dashboard/report/guard 均收到）；trace.jsonl 每行可解析、字段齐全、start/end 配对 | 是 |
| ③ 回放 | 否 | 否 | 用录制的 trace.jsonl：仪表盘渲染一致性、report 生成确定性（同 trace → 同 report 字节） | 是 |
| ④ 闭环 | **是** | Phase 2 需 | 变异测试 A/B（下）；R1-⑤ 失败恢复；每个剧本端到端（注入→根因层正确→处置类型正确→verify 通过）；收敛断言（§8） | 手动/nightly |

**变异测试（R1-④ 非剧本化的黄金证明）**：
- **变异 A（Phase 1）**：把 fixture 的 `CORS_ORIGIN_ALLOW_ALL` 改为 `False` 后重跑 → Agent **必须不再**处置 NET-001，转而选择次高优先级可修复项（如 NET-003）。断言：处置对象变化 + 工具序列变化。
- **变异 B（Phase 2）**：注入 `redis_auth_mismatch` 替代 `db_auth_mismatch` → 根因结论（credential 但对象不同）与处置动作必须随之变化。
- 判定标准：**同一份代码，仅改环境数据，Agent 行为随之改变** —— 这才证明决策来自观察而非写死流程。
- 断言方式一律为结构断言（根因层标签、处置动作类型、finding 状态迁移），**不断言逐字输出**。

## 11. Phase 1 交付物与验收（无 Docker 依赖，仅需 API Key）

**交付**：core/registry/static-tools + rules + signatures（静态部分）+ run-agent + events/bus + guard/budget + trace/recorder + prompts/system.md + dashboard(V1) + tests ①②③ + README。命令：`npm run env-check` / `demo:static` / `demo:static -- --ui` / `replay` / `test`（①②③）/ `test:e2e`（④）。

**验收（全部可机械检查）**：
1. `env-check` 报告 Key 就绪、Docker 缺失并提示 colima 路径、输出可用 compose 形态与可选 model ID；
2. **工具隔离**：契约测试通过——Agent 可用工具集 == 13 个自定义工具，无内置工具（R1-①）；
3. `traces/<run-id>/` 下 trace.jsonl/md + report.md + fixture/ 齐全；run-id 命名 = `<UTC时间戳>-<短uuid>`；
4. **闭环链**：trace 中四类工具各至少一次（`repo_scan` → ≥1 取证类 → `override_generate` → `config_verify`），**不设调用次数下限**（原「≥6 次」阈值过脆，已废弃）；
5. report.md 四段标题与必含要素符合 §3 模板；被处置 finding 在 after 中 `status=fixed`；
6. CRITICAL 密钥类 finding 仍列报告且 `status=advisory` + secrets 迁移建议（诚实边界：不假装已修复）；
7. override 产物通过 `docker-compose -f docker-compose.yml -f docker-compose.override.yml config -q`（standalone 二进制，无需 daemon）；
8. **原仓库零污染**：`git -C netbox-docker status --porcelain` 输出为空（处置只发生在 fixture）；
9. **收敛断言**（R8）：工具调用总数 ≤15、重复 ≤1、阶段回退 ≤1、预算未超限；
10. **可视化**：live 模式 9377（或实际端口）可访问，卡片 running→finished 迁移，**事件序列/计数/工具名/参数摘要与 trace 完全一致**（耗时以 trace 为唯一事实源，不断言偏差）；replay 渲染与 live 一致（同一代码路径）；run 结束四阶段全覆盖 + 收敛度面板有值 + 报告面板渲染；
11. **R1-⑤ 失败恢复**：诱导调用不可用工具（如 L2 工具）→ Agent 收到结构化错误后不崩溃，轨迹中可见错误与其后的策略调整；
12. **R1-④ 变异测试 A** 通过（处置对象与工具序列随数据变化）；
13. tests ①②③ 全绿且总耗时 < 30s、零 LLM 调用、零 Docker 调用。

## 12. Phase 2 交付物与验收（需 colima 与故障注入授权）

**环境**：`brew install colima && colima start --cpu 2 --memory 4`；首次 pull 约 1–1.5GB。注意 compose volume 名以目录名为前缀（fixture 目录名不同则不冲突，但需 cleanup 残留 volume）。
**交付**：runtime-tools 六工具 + signatures 完整库 + harness/fault-driver（7 个必做剧本）+ `npm run demo:runtime` + tests ④ 剧本端到端 + V2 extension（可选）。
**验收**：① 每个必做剧本：Agent 经必需观测面发现异常、`fault_classify` 命中正确 signature、根因层判定正确（对照 §6.2 矩阵）；② `allowed_hosts_reject` 必须经 `http_probe` 发现（仅看 `stack_status` 不足以定位，以此证明多观测面必要性）；③ `healthcheck_start_period` 的处置必须是调 start_period 而非重启服务（不误诊）；④ 处置后 `health_verify` 确定性判定恢复；⑤ 剧本可重入 + cleanup 后无残留（容器/volume/fixture）；⑥ 变异测试 B 通过；⑦ V1 仪表盘 runtime 模式五面板（Findings 表含 runtime 分区）；⑧ 收敛断言同 Phase 1；⑨ V2 若实施：pi-web-ui 可见 SRE 工具卡片（演示性，非硬验收）。

## 13. 风险与依赖

- pi SDK 较新，API 以包内 `.d.ts` 为准微调（已核对 createAgentSession/defineTool/noTools/事件模型）；`tools` 白名单与 `noTools:"builtin"` 的组合行为**必须实测确认**，若不符预期则改用 `excludeTools` 显式排除内置工具；
- pi-web-ui 为第三方包（MIT，v0.64.3，17 依赖含 node-pty 原生模块，npm 12+ 需 `--allow-scripts=node-pty`）：标可选，主验收不依赖；
- LLM 非确定性 → 一律结构断言 + 变异测试，不断言逐字输出；昂贵测试隔离到 ④ 层；
- colima 首启与 NetBox 迁移耗时数分钟属预期；fixture 与 volume 残留由 cleanup 保障；
- YAML 依赖 js-yaml（唯一），override 合并的幂等性有单元测试保障；
- 静态处置诚实边界内置（auto_fixable 标志 + advisory 状态 + 验收 6）。

## 14. 明确不做

- 不碰 NetBox 业务数据/生产语义；不修改用户克隆的原仓库（一切写操作在 fixture）；
- 不自动执行密钥轮换与 secrets 迁移（只给建议与模板）；
- 不追求穷尽真实故障空间（剧本以「每个考验一条不同诊断路径」为准则，资源类列 P2）；
- 不做多租户/服务化/前端框架工程（可视化仅限本地零依赖仪表盘 + 可选 pi-web-ui）；
- 不引入 pi SDK 之外的 Agent 框架，不自研 LLM 协议层；
- 不把 `fault_inject` 暴露给 Agent（harness 职责，避免自导自演）。
