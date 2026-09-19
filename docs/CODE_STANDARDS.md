# CODE_STANDARDS:DataAgent Workbench

> 适用于本仓库全部代码。评审以本文为准;与 SPEC/ARCHITECTURE 冲突时先改文档再改代码。

## 1. 总则

1. **TDD 红绿重构**:`src/core` 每个模块先有失败测试再有实现;新增行为 = 先加用例。测试文件与源码同目录 `*.test.ts`;core 夹具在 `packages/beidou-core/test-fixtures/`。
2. **core 零平台依赖**:`src/core` 禁止 import `electron`、`react`、Node 专属 API(`fs`/`net` 等一律经 `ToolDeps` 注入)。允许:`node:util` 等纯工具。
3. **fail-closed**:解析不了、校验不过、外部依赖异常——一律返回结构化错误并停止,绝不「尽量继续」。错误是值:`Result<T, AppError>`,`AppError = {code, message, detail?}`。
4. **派生物不可手改**:index/、审计只追加、Evidence 由工具生成——任何写路径都要能重建。
5. 文件即权威:语义资产只认 workspace 目录下的文件;代码里不硬编码任何业务指标/表名。

## 2. TypeScript 约定

- `strict: true`;禁 `any`(确需时 `unknown` + 收窄并注释原因);导出函数显式返回类型。
- 命名:类型/接口 `PascalCase`;函数/变量 `camelCase`;常量 `SCREAMING_SNAKE`;文件 kebab-case。
- 领域词汇表(与 DataBuddy 术语对齐,禁止另造):`MetricMirror`、`DatasetCard`、`GlossaryTerm`、`IntentRoute`、`EvidenceItem`、`AuditEvent`、`GuardResult`、`caliber`(口径)。
- 模块出口:每个目录 `index.ts` 只 re-export 公共 API;测试可以 import 内部路径。
- 禁止循环依赖(core 内部依赖方向:`types ← semantics/compiler/guard/router/services ← evidence/audit`)。

## 3. 测试规范

- 框架 Vitest;命名 `describe('模块') > it('行为(中文描述)')`。
- **用例数据优先取真实样例**:北斗 JSON 抽样放进 `tests/fixtures/beidou/`(截断到最小可复现);SQL 攻击样例集中放 `tests/fixtures/sql-attacks.ts`。
- 每个对外行为至少:一条正常路径、一条边界、一条 fail-closed。
- 契约测试:system prompt 中出现的路由规则、guard 白名单、技能 frontmatter 必须有对应断言测试(改文案能被测试抓住)。
- 禁止:测试内 `setTimeout` 等真实等待;mock 一律注入(fake fetch/fake query)。
- 覆盖率:`packages/beidou-core/src` 行覆盖 ≥85%(`npm run test:coverage --workspace @beidou/core`) 才允许合入(vitest --coverage)。

## 4. SQL 与数据安全

- 生成/执行 SQL 必须经 `guard/sql-guard`;工具层不得绕过。
- 查询参数化优先;无法参数化的标识符(表/列名)必须过 `^[A-Za-z_][A-Za-z0-9_]*$` 且在白名单。
- 连接配置中的密钥只存 workspace `config.yaml`(gitignore 模板默认排除),日志与审计中脱敏(复用 `evidence/redact`)。
- 结果分级:>500 行不进 LLM 上下文,落 workspace 文件并返回摘要+路径。

## 5. Electron / 进程

- Renderer 零 IO;跨进程只走 `preload` 暴露的类型化 API(`src/preload/api.d.ts` 是唯一契约)。
- Main 中长任务(导入/查询)必须可取消(AbortSignal 贯穿),UI 不阻塞。
- Agent SDK 只在 `main/agent/sdk-adapter.ts` 出现,版本升级只改这一个文件。

## 6. Git 与工程

- 分支:`main` 保护;功能分支 `feat/<scope>-<desc>`;commit 中文、祈使句,一次一事。
- 提交前必须过:`lint(tsc --noEmit + eslint) + vitest`。
- 目录即模块边界;新增顶层目录需在 ARCHITECTURE.md 补一节。
- 依赖新增需在 PR/commit 说明用途;运行时依赖最小化(能 stdlib 不三方)。

## 7. 文档同步义务

- 改路由协议/护栏规则/资产 schema → 同步 SPEC 对应条目 + 契约测试。
- 每个交付节点更新 `docs/CHANGELOG.md`(简版:日期/变更/验收状态)。
