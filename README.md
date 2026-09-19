# 北斗work

仿腾讯云 DataBuddy 的桌面端数据智能体工作台:语义配置 + 技能/插件 + 智能问数(指标 → 口径一致下钻 → 无指标明细分析)。

- Monorepo(npm workspaces):`packages/beidou-core`(核心能力,零依赖)/ `packages/domain-contracts`(协议层)/ `apps/desktop`(Electron 壳);后续 `packages/ontology-schema`、`packages/dsh-plugin-beidou`
- 设计文档:`docs/SPEC.md`(自问自答 spec)、`docs/ARCHITECTURE.md`、`docs/CODE_STANDARDS.md`、`docs/plans/poc-dsh-plugin-v2.md`(PoC 基线 V2.1)
- 参考:`~/databuddy/DataBuddy产品与技术架构详解.md` 等研究文档

## 技术栈

Electron + React + TypeScript | Claude Agent SDK + DeepSeek(Anthropic 兼容端点)| StarRocks(mysql2 只读)| 北斗 AnyMetrics 导出

## 快速开始

```bash
npm install
npm install
npm test            # 全 workspace 测试(core 183 + contracts + desktop e2e)
npm run desktop:dev # 桌面应用开发
npm run desktop:dist # dmg 打包
```

首次启动会在默认工作区(userData/workspace)生成模板:`config.yaml`、`semantics/glossary.yaml`、`.claude/skills/`(三个内置技能)。

## 配置三步

1. **导入语义资产**:把北斗导出(`metrics.json / details.json / dimensions.json / tree.json / lineage_summary.json / physical_tables.json`,即 `~/北斗指标本体/output/adss/` 下的文件)复制到工作区 `semantics/import/`。
2. **插件页**编辑 `config.yaml`:模型(DeepSeek key,建议环境变量 `DEEPSEEK_API_KEY`)、StarRocks 只读连接;点「连接测试」。
3. **对话页**提问。未配模型时为演示模式(确定性管线,全链路可用);未配 StarRocks 时指标/明细查询会明确报「未配置」——fail-closed,不编数。

## 核心机制(与 DataBuddy 对齐)

| 机制 | 实现 |
|---|---|
| 语义路由 | system prompt 协议 + `search_semantics` 工具(同义词/中文反包含/打分),路由策略纯函数可测 |
| 口径一致下钻 | `MetricSqlCompiler`:平台 caliber 公式 AST + 过滤 DSL + 列映射 → SQL,**LLM 不写 SQL** |
| 无指标明细 | `buildExploreSql`:结构化参数(白名单表/列/聚合)拼装 SQL |
| SQL 护栏 | `sql-guard` token 级静态分析:单语句/只读首词/关键词黑名单/表白名单/强制 LIMIT/敏感列;数据库侧只读账号兜底 |
| 证据应答 | EvidencePack:口径/SQL/血缘链/行数/截断标记,渲染在右侧证据面板 |
| 审计 | workspace `audit/audit.jsonl`,只追加、写入前脱敏 |
| 技能 | SKILL.md 即文件,Agent SDK 从工作区自动加载 |

## 目录

```
src/core/     纯 TS 核心逻辑(零 electron 依赖,TDD 主战场)
src/main/     Electron 主进程:workspace / AgentService / SDK 适配 / IPC
src/preload/  contextBridge 白名单 API
src/renderer/ React 六页:对话/语义/技能/插件/审计/设置
resources/    工作区模板(含内置技能)
tests/        夹具与 e2e 冒烟
```
