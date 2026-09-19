# ARCHITECTURE:DataAgent Workbench

> 对应 SPEC v0.1。四层仿 DataBuddy,映射到单机桌面形态。

## 1. 总体分层(仿 DataBuddy L1–L4)

```
┌───────────────────────────────────────────────────────────────┐
│ L1 入口层(Electron Renderer,React)                            │
│    Chat / 语义配置 / 技能配置 / 插件配置 / 审计 / 设置            │
├───────────────────────────────────────────────────────────────┤
│ L2 控制面(Electron Main)                                       │
│    AgentService(会话管理、system prompt 路由协议)               │
│    WorkspaceService(workspace 目录生命周期、导入、重建索引)      │
│    AuditService / ConfigService                                │
├───────────────────────────────────────────────────────────────┤
│ L3 Harness 层(Claude Agent SDK + DeepSeek)                     │
│    进程内 MCP server,4 个工具:                                 │
│    search_semantics / query_metrics / query_dataset / clarify  │
│    PreToolUse hook → sql-guard(统一拦截闸门)                   │
├───────────────────────────────────────────────────────────────┤
│ L4 数据层                                                       │
│    语义资产(workspace 目录:北斗导入 + glossary,文件即权威)     │
│    AnyMetrics API(指标数值,在线模式)                           │
│    StarRocks(明细分析,只读账号 + guard)                        │
└───────────────────────────────────────────────────────────────┘
横切:审计(JSONL 全量)、EvidencePack(口径/血缘/SQL/行数/耗时)
```

与 DataBuddy 的对应:L1=WeData 入口;L2=控制面 Server;L3=同源沙箱(一会话一 Runtime,由 Agent SDK session 保证);L4=DLC/湖仓(此处为 AnyMetrics+StarRocks)。

## 2. 核心数据流

### 2.1 语义资产构建(导入时)
```
北斗 output/<tenant>/ 目录
  metrics.json ──┐
  details.json ──┤ Importer(纯函数)→ 资产对象 → index/(派生索引)
  dimensions.json┤   MetricMirror[]    - 倒排:中文/英文名/同义词 → 资产
  tree.json ─────┤   DatasetCard[]     - 类目树
  lineage_summary.json ┘               - 表→指标 反向索引
                                       - 血缘边:metric→dataset→physical_table
glossary.yaml(人工)→ 合并进倒排(同义词扩展)
```

### 2.2 问数执行(运行时)
```
Agent 循环(Agent SDK):
  system prompt(路由协议)+ skills(workspace/skills/*.SKILL.md 自动加载)
  ① search_semantics(q) → 候选(带 score:文本×类型权重×被引用数)
  ② 命中指标 → query_metrics(metric, dims, timeRange) → AnyMetrics / 未配 → 编译口径 SQL 走 ③
  ③ 明细/下钻 → query_dataset:
       a. metric-drilldown:MetricSqlCompiler(caliber AST+filters DSL+列映射)→ CTE SQL
       b. dataset-analysis:白名单表 + LLM 提供的 select 列/where(受限 DSL)/聚合 → SQL Builder
     → sql-guard(见 2.3)→ StarRocks 只读执行(超时/LIMIT)→ 结果分级(>N 行落文件)
  ④ 证据不足 → clarify(questions[]) → Renderer 呈现澄清
每次工具调用 → EvidenceItem + AuditEvent
```

### 2.3 sql-guard(双层防线)
```
输入 SQL
 → tokenize(剥离 '' "" `` 字符串与 -- /* */ 注释)
 → 规则链:
    R1 单语句(无裸分号)         R2 首词 ∈ {SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN}
    R3 token 黑名单(DDL/DML/管理词) R4 表提取 → 全部 ∈ 白名单(语义资产中的物理表)
    R5 LIMIT:无则追加,有则收紧到 ≤ maxRow   R6 敏感列黑名单
 → 通过 → 执行(只读连接 + query_timeout + 行数截断 sentinel)
 → 任何规则失败 → GuardRejection{rule, reason}(fail-closed,可解释)
```

## 3. 模块责任(全部在 src/core,纯 TS)

| 模块 | 职责 | 关键出口 |
|---|---|---|
| `types.ts` | 领域类型唯一来源 | MetricMirror/DatasetCard/GlossaryTerm/IntentRoute/EvidenceItem/AuditEvent/ToolDeps |
| `semantics/importer.ts` | 北斗 JSON → 资产(容错:缺文件跳过并记录) | `importBeidou(dir): SemanticAssets` |
| `semantics/store.ts` | 内存索引 + 检索(同义词扩展、打分、类型权重、被引用数) | `buildStore(assets)` → `search(q, opts)` |
| `semantics/validate.ts` | glossary/bindings/schema 校验(错误定位到行) | `validateGlossary(text)` |
| `compiler/dsl.ts` | caliber.formula AST → SQL expr;filters DSL 文本 → SQL 谓词 | `compileFormula(ast, colMap)` |
| `compiler/metric-sql.ts` | 口径完整编译:CTE + 时间过滤 + 维度 group by + 分页 | `compileMetricSql(metric, dims, timeRange, colMap)` |
| `guard/sql-guard.ts` | 见 2.3 | `guard(sql, policy): GuardResult` |
| `router/policy.ts` | 路由决策纯函数(供 system prompt 描述与 UI chip 共用) | `decideRoute(searchResult, config)` |
| `services/anymetrics.ts` | 平台客户端(注入 fetch;list/detail/dimension/query) | `createQueryMetrics(deps)` |
| `services/starrocks.ts` | mysql2 封装(注入;只读、超时、行数上限、sentinel 截断) | `query(sql, opts)` |
| `evidence/pack.ts` | EvidenceItem 组装与脱敏 | `buildEvidence(...)` |
| `audit/log.ts` | JSONL append/read(注入 fs) | `append(event)` / `tail(n)` |

## 4. Electron 侧组装

- `main/agent/AgentService.ts`:会话注册表、`query()` 流式转发到 Renderer(IPC `agent:message`)、中断;SDK 环境变量注入(DeepSeek)。
- `main/agent/tools.ts`:`createSdkMcpServer` 把 core 组装成 4 工具(zod 入参校验;工具内再走 guard;结果附 EvidenceItem)。
- `main/agent/prompt.ts`:system prompt = 路由协议(与 `router/policy.ts` 同源生成,避免双写漂移)。
- `main/ipc.ts`:工作空间打开/导入/检索/审计等 Renderer API(contextBridge 暴露白名单方法)。
- 隔离:Renderer 无任何 IO;一切经 IPC。

## 5. 关键设计决策记录(ADR 摘要)

| # | 决策 | 理由 | 放弃项 |
|---|---|---|---|
| A1 | Electron 而非 Tauri | Agent SDK(Node)进程内直用 | Tauri+sidecar |
| A2 | 语义资产=文件,索引=派生物 | DataBuddy Semantic-as-Code;Git 可管;避免 GraphDB 运维 | RDF/GraphDB(售后路线) |
| A3 | 下钻 SQL 由编译器生成,LLM 不写自由 SQL | 口径一致性结构性保证;fail-closed | LLM 生成 SQL+事后校验 |
| A4 | guard 用 TS tokenizer 而非 sqlglot sidecar | 单运行时;白名单表+只读账号+黑名单组合已够 MVP | Python sidecar(列为演进项) |
| A5 | Agent SDK cwd=workspace 目录 | skills 自动加载,技能即文件 | 自研技能加载器 |
| A6 | 双数据源模式(local/online)+ mock 模式 | 无内网连接也能开发演示;如实披露 gap | 强依赖在线 |
