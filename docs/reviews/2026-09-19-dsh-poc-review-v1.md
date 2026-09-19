# 北斗 work × DeepSeek Harness 插件 PoC 改进建议 V1

> 依据《北斗work:dsh 插件 PoC + 本体模型升级计划》整理  
> 用途：方案评审、需求澄清、任务拆分、进入仓库 `docs/reviews/` 或 `docs/plans/`

---

## 1. 总体结论

原方案的核心方向可以保留：

- DeepSeek Harness 作为插件宿主；
- 北斗业务能力继续由自身 Core 实现；
- PoC 先验证工具插件，不做 DSH Desktop UI Patch；
- Core 不依赖 DSH、Electron、React；
- 通过 `context + adapter` 控制 Harness API 漂移；
- 本体采用受治理 YAML；
- 概念层与数据、指标、知识绑定层分离；
- 最终桌面壳在 PoC 完成后再决定。

需要改进的重点，不是推翻方案，而是解决以下五类问题：

1. 文档中的数量、路径和实施依赖存在不一致；
2. Core 与插件之间的工程边界还不够稳定；
3. 本体“概念层与绑定层分离”尚未完全落实到文件和发布机制；
4. 安全、权限、审计和失败策略仍偏 PoC，需要明确边界；
5. V1～V9 虽然清晰，但缺少机器可执行的验收标准和分阶段门禁。

---

# 2. P0：进入开发前必须修正

## P0-1 解决现有代码来源与仓库结构不一致

### 当前问题

方案大量依赖以下现有代码：

```text
app/src/core/tools/tools.ts
app/src/core/auth/idaas.ts
app/src/core/services/starrocks.ts
app/src/main/workspace.ts
app/src/main/agent/sdk-runner.ts
```

但当前用于承载规划的 `beidou-desktop` 仓库未明确包含这些代码。

### 改进要求

开发前必须确认：

- 这些代码当前所在仓库和分支；
- 是否迁移进入 `beidou-desktop`；
- 是否拆为独立 `beidou-core` 包；
- 原仓库和新仓库哪个是代码权威源；
- 现有测试、Node、pnpm、TypeScript 版本。

### 验收

仓库中增加：

```text
docs/architecture/source-baseline.md
UPSTREAM_COMMIT
BEIDOU_CORE_COMMIT
```

并写清：

```yaml
harness_repository:
harness_commit:
beidou_core_repository:
beidou_core_commit:
node_version:
pnpm_version:
typescript_version:
```

---

## P0-2 修正文档中的工具数量矛盾

### 当前问题

原方案写“工具清单（9）”，但实际列出：

- Core 工具 7 个；
- `list_ontology` 1 个；
- `beidou_login` 1 个；
- `beidou_auth_status` 1 个。

合计是 **10 个工具**。

### 改进要求

明确最终工具目录，并将业务工具和平台工具分组：

```text
业务查询工具（8）
- search_semantics
- query_metrics
- query_dataset
- clarify
- diagnose_metric
- search_knowledge
- read_playbook
- list_ontology

身份工具（2）
- beidou_login
- beidou_auth_status
```

同时明确 `metricOnline=false` 时：

- `query_metrics` 是否仍注册；
- 是返回“在线指标关闭”，还是切换到 Mock；
- V3、V4 使用的是 Mock 还是编译结果。

---

## P0-3 不采用跨仓库相对路径直接引用 TS 源码作为正式方案

### 当前问题

原方案计划：

```text
../../app/src/core/...
```

直接引用 TypeScript 源码，并依赖 DSH Loader 编译链。

这种方式只适合第一小时技术验证，不适合作为正式结构，风险包括：

- 仓库目录变化即失效；
- DSH Loader、tsconfig、module resolution 改动会导致构建失败；
- Core 与插件无法独立测试和发布；
- CI、容器和开发机路径不一致；
- 后续升级难以识别真实依赖。

### 改进方案

优先采用 pnpm workspace：

```text
packages/
├── beidou-core/
├── domain-contracts/
├── ontology-schema/
└── dsh-plugin-beidou/
```

插件依赖：

```json
{
  "dependencies": {
    "@beidou/core": "workspace:*",
    "@beidou/domain-contracts": "workspace:*"
  }
}
```

如短期不能迁移 Core，则先构建 Core 产物：

```text
beidou-core/dist
```

插件引用稳定产物，不直接穿透到源码目录。

### 验收

- 插件可单独构建；
- Core 可单独测试；
- 修改仓库物理目录不会破坏 import；
- `beidou-core` 中不存在 DSH、Electron、React import。

---

## P0-4 将本地绝对路径改为可移植配置

### 当前问题

原方案包含：

```text
/Users/jiatianfu/databuddy/dsh-plugin-beidou
```

并要求 `cordis.yml` 插件路径为绝对路径。

这可以本机验证，但无法直接用于其他开发者、CI 或容器。

### 改进方案

- 仓库内保存 `cordis.example.yml`；
- 通过启动脚本动态解析仓库绝对路径；
- 不提交个人目录；
- CI 和本地统一入口。

建议：

```bash
pnpm dsh:poc
```

由脚本生成临时 Patch 配置：

```text
.tmp/cordis.local.yml
```

### 验收

在不同目录 clone 仓库后，仅执行：

```bash
pnpm install
pnpm dsh:poc
```

即可加载插件。

---

## P0-5 调整实施顺序，先补本体最小内核，再跑依赖本体的验收

### 当前问题

原顺序先执行：

```text
context/adapter/tools → V2～V6
```

之后才建设：

```text
ontology.ts
ontology-validate.ts
list_ontology
```

但 V2 语义检索、V4 口径下钻、V5 诊断以及 `list_ontology` 都依赖新的本体结构或至少依赖稳定的兼容层。

### 修订顺序

1. 锁定 Harness 与 Core 基线；
2. 插件空壳加载，完成 V1；
3. 建立 `domain-contracts`、错误码和工具协议；
4. 建立 Ontology V1 Schema、解析器、兼容转换器和 Validator；
5. 接入 `search_semantics`、`list_ontology`，完成 V2；
6. 接入 Mock 指标、诊断、知识和 Playbook，完成 V3～V6；
7. 接入 IDaaS，完成 V7；
8. 接入多连接、白名单和真实只读 StarRocks，完成 V8～V9；
9. 再评估最终壳。

---

## P0-6 明确 Fail-open 与 Fail-closed 边界

### 当前问题

原方案规定本体解析：

```text
坏文件 → 告警 + 部分结果
```

这适合开发预览，但不能覆盖所有运行场景。

### 改进规则

| 场景 | 策略 |
|---|---|
| 本体搜索与预览 | 可部分 fail-open，并显示告警 |
| 本体发布 | fail-closed |
| 指标绑定缺失 | 拒绝执行对应指标查询 |
| 数据表绑定无效 | 拒绝查询 |
| 权限配置读取失败 | fail-closed |
| 白名单读取失败 | fail-closed |
| 知识文件缺失 | 可降级，但必须标注证据不足 |
| 审计写入失败 | PoC 可返回告警；生产需按策略阻断高风险调用 |

必须禁止：

- 权限系统异常时默认放行；
- Binding 无效时自动猜表；
- 指标版本冲突时自动选择一个版本。

---

## P0-7 将 IDaaS 的固定 `owner` 限定为单用户 PoC

### 当前问题

原方案使用：

```text
app_id = beidou-desktop
open_id = owner
```

Token 落本地用户文件。

### 改进要求

PoC 可以保留，但必须在配置和文档中明确：

```yaml
auth_mode: single-user-poc
```

并补充：

- Token 不进入日志；
- Token 文件最小权限；
- 支持过期和刷新；
- 登录状态与 Harness Session 的关系；
- 注销与清理；
- 多用户试点前必须替换固定 `owner`；
- 服务账号与真实用户账号不能混用。

### 生产前置条件

进入多人环境前，必须支持：

```text
真实 open_id
用户隔离
租户/组织上下文
加密或系统 Keychain
集中撤销
审计关联用户身份
```

---

# 3. P1：PoC 阶段应同步优化

## P1-1 进一步落实“概念层与绑定层分离”

### 当前问题

原方案理念上要求分离，但示例仍把 Binding 写在 Class 内：

```yaml
classes:
  - id: Store
    bindings:
      dataset:
      table:
      connection:
    metrics:
    knowledge:
```

这样 Class 的稳定定义和高频变化的物理绑定仍在同一文件、同一版本中。

### 建议目录

```text
semantics/
├── ontology.yaml
├── glossary.yaml
├── metrics.yaml
└── bindings/
    ├── datasets.yaml
    ├── tables.yaml
    ├── metrics.yaml
    └── knowledge.yaml
```

### 建议原则

- `ontology.yaml`：实体、属性、关系、动作；
- `bindings/*.yaml`：数据、指标、知识和连接指针；
- 概念版本和 Binding 版本独立；
- 修改数据库表名不要求本体主版本升级；
- 删除实体或属性必须生成影响面报告。

---

## P1-2 补充本体治理字段

当前 Schema 已有 `id/name/subdomain/topic/extends/key/properties`，建议补充：

```yaml
description:
aliases:
status: draft | published | deprecated
owners:
tags:
effectiveFrom:
effectiveTo:
source:
sensitivity:
```

属性建议补充：

```yaml
nullable:
semanticType:
unit:
format:
enumRef:
sensitivity:
description:
```

Relation 建议补充：

```yaml
inverseOf:
description:
effectiveTime:
```

Action 建议补充：

```yaml
inputSchema:
outputSchema:
requiredRoles:
evidencePolicy:
confirmationPolicy:
timeout:
```

PoC 不要求全部实现运行逻辑，但 Schema 应为后续治理保留位置。

---

## P1-3 给插件增加统一协议层

原方案已有 `context.ts` 与 `adapter.ts`，建议再加入：

```text
schemas.ts
errors.ts
policy.ts
telemetry.ts
```

### 统一 Tool 返回结构

```ts
type BeidouToolResult<T> = {
  ok: boolean
  code: string
  data?: T
  message?: string
  warnings?: string[]
  evidence?: EvidenceRef[]
  traceId: string
  presentation?: PresentationMeta
}
```

### 统一错误分类

```text
AUTH_REQUIRED
AUTH_EXPIRED
FORBIDDEN
INVALID_INPUT
ONTOLOGY_INVALID
BINDING_NOT_FOUND
METRIC_UNAVAILABLE
DATA_SOURCE_UNAVAILABLE
QUERY_REJECTED
QUERY_TIMEOUT
KNOWLEDGE_NOT_FOUND
INTERNAL_ERROR
```

这样 Agent 不需要解析自然语言错误。

---

## P1-4 完善数据查询安全边界

原方案已经包含连接 Profile、环境变量凭据和表白名单，但还需补充：

- 字段白名单；
- 行级权限；
- 组织权限；
- 最大扫描量；
- 最大返回行数；
- 查询超时；
- 禁止 DDL/DML；
- 禁止多语句；
- 查询参数化；
- 敏感字段脱敏；
- 查询成本预估；
- Query ID 和审计关联。

### Connection Router 冲突规则

必须明确定义：

- 多个规则同时命中时的优先级；
- 未命中 default 时的处理；
- 同一表绑定多个 Profile 是否允许；
- Binding 和数据资产目录冲突时以谁为准；
- 禁止通过用户输入覆盖 connection profile。

---

## P1-5 将本地 JSONL 审计定义为 PoC 实现，不作为最终审计方案

PoC 可继续使用：

```text
<workspace>/audit/audit.jsonl
```

但建议统一审计事件 Schema：

```yaml
timestamp:
traceId:
sessionId:
userId:
tenantId:
tool:
toolVersion:
inputSummary:
policyDecision:
dataSources:
knowledgeSources:
durationMs:
resultCode:
errorCode:
```

并预留：

```text
AuditSink Interface
├── JsonlAuditSink
└── RemoteAuditSink
```

---

## P1-6 强化业务 Skill 定义

现有两个 Skill 的执行链和红线可以保留，但应从纯自然语言说明升级为结构化定义：

```yaml
id:
name:
version:
businessGoal:
applicableRoles:
inputSchema:
requiredTools:
steps:
evidencePolicy:
dataPolicy:
sensitiveFields:
crossDomainPolicy:
outputSchema:
failureFallback:
evaluationCases:
```

特别需要明确：

- “知识库无证据则待业务确认”的输出结构；
- 事实、推断、建议三者分开；
- VIN、Phone 等字段在工具输出阶段即脱敏，而不是只要求模型不展示；
- 跨子域分析必须显式授权。

---

## P1-7 把 V1～V9 改造成可执行验收用例

每个验收项增加：

```yaml
id:
precondition:
input:
expectedToolCalls:
expectedOutput:
expectedEvidence:
expectedAudit:
expectedError:
performanceTarget:
automation:
```

### 建议分门禁

#### Gate A：插件基础

- V1 插件装载；
- V2 语义检索；
- V6 审计；
- V8 白名单拒绝。

#### Gate B：业务闭环

- V3 指标问答；
- V4 口径下钻；
- V5 四段诊断报告。

#### Gate C：企业集成

- V7 IDaaS；
- V9 真实只读 StarRocks。

### 增加的测试

- Ontology 内容变更未升版本；
- Extends 环；
- Relation 指向不存在 Class；
- Binding 指向不存在表；
- 多连接路由冲突；
- Token 过期；
- 白名单加载失败；
- Prompt 注入绕过查询护栏；
- 敏感字段泄漏；
- Harness API 升级兼容测试。

---

# 4. P2：建议后置

以下内容不应阻塞插件 PoC：

- 完整本体维护 UI；
- DSH Desktop UI Patch；
- 桌面正式打包；
- 插件市场发布；
- 飞书集成；
- 通用 BPMN/SOP 引擎；
- 自动血缘；
- 通用拖拽看板；
- 多租户商业化；
- 完整 RDF/OWL 运行时推理。

但是应在文档中保留接口和演进路径，避免 PoC 形成不可迁移实现。

---

# 5. 建议修订后的仓库结构

```text
beidou-desktop/
├── apps/
│   └── desktop/                 # 如保留现有北斗 Electron 壳
├── packages/
│   ├── beidou-core/
│   ├── domain-contracts/
│   ├── ontology-schema/
│   └── dsh-plugin-beidou/
├── workspaces/
│   └── service-domain-example/
│       ├── semantics/
│       │   ├── ontology.yaml
│       │   ├── glossary.yaml
│       │   └── bindings/
│       ├── knowledge/
│       ├── playbooks/
│       └── scope/
├── scripts/
│   ├── migrate-entities.ts
│   ├── ontology-lint.ts
│   └── generate-cordis-config.ts
├── docs/
│   ├── adr/
│   ├── plans/
│   ├── specs/
│   ├── acceptance/
│   └── reviews/
└── infra/
```

---

# 6. 修订后的实施计划

## Phase 0：基线与决策

交付：

- Harness commit；
- Core commit；
- 仓库边界；
- Node/pnpm/TS 版本；
- 工具清单；
- PoC 用户模式；
- 首个子域；
- 首个真实问题；
- ADR。

## Phase 1：Harness 空壳验证

交付：

- 插件加载；
- 动态 Cordis 配置；
- 统一 Tool 协议；
- 一个 Dummy Tool；
- V1 自动化测试。

## Phase 2：Ontology V1

交付：

- Schema；
- Parser；
- Validator；
- 兼容迁移；
- Ontology Lint；
- `search_semantics`；
- `list_ontology`；
- V2。

## Phase 3：Mock 业务闭环

交付：

- Mock 指标；
- `diagnose_metric`；
- 知识递归读取；
- Playbook；
- 结构化 Skill；
- 审计；
- V3～V6。

## Phase 4：身份与真实数据

交付：

- IDaaS；
- Token 生命周期；
- 多连接；
- Connection Router；
- 表/字段白名单；
- StarRocks 只读；
- V7～V9。

## Phase 5：PoC 结论

形成对比报告：

```text
Harness Web
Harness Desktop
现有北斗 Electron
独立业务 Web
```

评估维度：

- UI 可扩展性；
- 工具轨迹；
- Session；
- 持久化；
- 打包；
- 安全；
- 升级成本；
- 多用户适配；
- 开发成本。

---

# 7. 需要负责人确认的决策

## 必须在编码前确认

1. `app/src/core` 当前在哪个仓库和分支？
2. 是否将 Core 拆成 Workspace Package？
3. 当前使用 GitHub 还是 GitLab 作为代码权威源？
4. 资产仓库是否仍计划与代码分仓？
5. PoC 首个子域是仅“门店经营”，还是同时包含“用户体验”？
6. V3/V4 使用纯 Mock、编译结果，还是真实指标接口？
7. V9 是否是本轮强制验收项？
8. `beidou-desktop/owner` 是否明确只用于单用户 PoC？
9. 真实 StarRocks 是否已有测试账号和只读权限？
10. PoC 的成功标准是“插件可运行”，还是“完成一个真实诊断任务”？

## 可在 PoC 中确认

- Topic 后续是否升级为独立治理资产；
- 最终桌面壳；
- 是否建设本体管理 UI；
- 指标平台正式联调时间；
- Keychain 或集中凭据服务；
- 集中审计平台；
- 多用户和租户模型。

---

# 8. 推荐优先级总表

| 优先级 | 改进项 | 是否阻塞开发 |
|---|---|---|
| P0 | 确认 Core 代码来源 | 是 |
| P0 | 锁定 Harness/Core commit | 是 |
| P0 | 修正工具数量和 Mock 行为 | 是 |
| P0 | 去除跨仓库相对源码依赖 | 是 |
| P0 | 调整 Ontology 与工具实施顺序 | 是 |
| P0 | 明确 fail-open/closed | 是 |
| P0 | 限定固定 owner 为单用户 PoC | 是 |
| P1 | 概念与 Binding 物理拆分 | 建议 PoC 完成 |
| P1 | 统一 Tool 协议和错误码 | 建议 PoC 完成 |
| P1 | 完善数据安全护栏 | 真实数据前完成 |
| P1 | 结构化 Skill | 业务验收前完成 |
| P1 | V1～V9 自动化 | PoC 结项前完成 |
| P2 | UI Patch、管理后台、完整 SOP/BI | 后置 |

---

# 9. 评审结论

原方案可以继续作为技术 PoC 的基础，但在开始编码前至少应完成以下七项：

1. 明确现有 Core 代码和仓库基线；
2. 将 Core 变成稳定包边界，不依赖跨目录 TS 源码；
3. 修正工具数量及 Mock/Online 行为；
4. 调整实施顺序，先建立最小 Ontology 内核；
5. 明确解析、权限、Binding 和审计的失败策略；
6. 将固定 owner 和本地 JSONL 明确限制为 PoC；
7. 将 V1～V9 转成可执行验收用例。

完成上述改进后，方案才适合进入正式任务拆分和代码实施。
