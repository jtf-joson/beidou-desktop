# SPEC:DataAgent Workbench(仿 DataBuddy 桌面端数据智能体工作台)

> 版本:0.1(2026-09-17)
> 本文档采用**自问自答(spec by Q&A)**方式编写:每个关键决策先提出问题、给出备选、再给出决定与理由。实现过程中出现新问题时在此追加条目,保持 spec 是单一事实源。
> 参考:腾讯云 DataBuddy 官方资料(见 ~/databuddy/DataBuddy产品与技术架构详解.md)、北斗指标本体导出(~/北斗指标本体)、售后用户体验Agent项目(WorkBuddy 工作空间,作为反面/正面模式参考)。

---

## S1 产品与范围

### Q1.1 我们在造什么?一句话?
一个**桌面端数据智能体工作台**:用户配置语义资产(指标/数据集/术语)、技能与数据源插件后,用自然语言对话完成「查指标 → 指标下钻明细 → 无指标数据集分析」;底层由语义路由决定调用哪个工具,每个答案携带口径与血缘证据。整体交互与架构**模仿腾讯云 DataBuddy**,做单机可落地的轻量版。

### Q1.2 明确不做什么(MVP 边界)?
不做:多租户/权限体系(SSO/CAM 类)、Agent 席位计费、实时集群管理、数仓建设(建表/ETL 编排)、Web 发布、飞书集成、 RDF/GraphDB/SPARQL 语义栈(售后项目路线,明确不采用)、移动端。
做:单机桌面应用,本地 workspace 目录管理语义资产,内置 SQL 护栏与审计。

### Q1.3 MVP 必须交付的核心能力(验收)?
1. **对话工作台**:输入自然语言问题 → Agent 语义检索 → 按路由执行(指标 API / StarRocks 受控 SQL / 澄清拒答)→ 回答附 EvidencePack(口径、指标名、物理表、SQL、行数、耗时)。
2. **语义配置页**:从北斗(AnyMetrics)导出 JSON 一键导入;术语表(glossary)增删改;语义资产浏览(指标/数据集/物理表/血缘);全部落 workspace 目录(可 Git 管理)。
3. **技能配置页**:SKILL.md 风格技能的启用/停用/编辑;内置三个技能:metric-qa(指标问答)、metric-drilldown(口径一致下钻)、dataset-analysis(无指标明细分析)。
4. **插件/数据源配置页**:StarRocks 连接、AnyMetrics 连接、模型(DeepSeek Anthropic 端点)配置与连通性测试。
5. **护栏与审计**:所有 SQL 过 guard(只读白名单+强制 LIMIT+敏感列拦截);全量审计日志(JSONL)可查。
6. **工程质量**:core 模块 TDD(先测试后实现),单测覆盖关键分支;`npm test` 全绿。

### Q1.4 什么算「跑通」(端到端冒烟)?
在配置好 StarRocks 连接后(或用内置 mock 数据源模式):问「智驾里程类指标有哪些」→ 列指标;问「XX 指标最近一个月的值」→ 走指标路由给出数值+口径;问「按车型看 XX 明细」→ 生成 CTE 口径一致 SQL 并执行返回表格。全程审计有记录。

## S2 架构与技术选型

### Q2.1 桌面端框架?
备选:Electron / Tauri。
**定:Electron**。理由:harness 层用 Claude Agent SDK(Node),Electron 主进程天然是 Node,Agent SDK 直接进程内调用;Tauri 需要额外 Node sidecar,徒增复杂。体积代价可接受(内部工具)。

### Q2.2 Harness(Agent 运行时)?
**定:Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)+ DeepSeek Anthropic 兼容端点**(此前已联网核实并经用户确认)。模型默认 `deepseek-flash[1m]`。Agent SDK 提供:agent loop、hooks(PreToolUse 做 SQL 护栏)、MCP(`createSdkMcpServer` 进程内自建工具)、structured output、sessions。dsh(DeepSeek Harness)仅观察不依赖。

### Q2.3 语言与运行时?
主语言 **TypeScript**(全栈:main/renderer/core);测试 **Vitest**。Python 不引入运行时依赖(北斗导入器直接读其 JSON 产物,不跑其脚本)。工具链:Node ≥22、electron-vite、React 18、antd 5(桌面管理界面风格匹配)。

### Q2.4 语义资产的技术形态?(最重要的路线问题)
备选:A) RDF/GraphDB/SPARQL(售后项目路线);B) 文件型 YAML/JSON + 内存索引 + SQLite 缓存;C) 嵌入式图数据库。
**定:B**。理由:用户明确「不是改成用 ontology」——DataBuddy 的语义资产本质是「受治理的配置文件 + 派生索引」(Semantic-as-Code,Git 管理);售后项目的 GraphDB 栈被其自身文档承认为重治理过度工程。文件是唯一权威源(source of truth),索引与血缘图全部是**派生物**(可随时重建,禁止手改——DataBuddy 四条红线之一)。

### Q2.5 数据流:一次提问怎么走?
```
用户问题(Renderer)
 → IPC → Main:AgentService(会话管理)
 → Agent SDK query()(system prompt = 路由协议;cwd = workspace 目录)
 → Agent 调工具(进程内 MCP server):
    ① search_semantics(查询词) → 语义检索(同义词扩展+打分) 返回候选指标/数据集/术语
    ② query_metrics(指标,维度,时间) → AnyMetrics API(或 mock)
    ③ query_dataset(数据集/表,分析意图) → 受控 SQL 编译 → sql-guard → StarRocks 只读执行
    ④ clarify(问题) → 返回澄清请求
 → EvidencePack 组装进工具结果,Agent 引用产出最终回答
 → 审计 JSONL 落盘;Renderer 渲染回答 + 证据面板
```

### Q2.6 语义路由由谁决定?
**定:Agent(LLM)决策 + 结构化约束兜底**。Agent 的 system prompt 写死路由协议(先检索、指标优先、证据不足必须澄清/拒答);同时工具层是白名单——Agent 只能通过我们的 4 个工具拿数,自由 SQL 只能走 `query_dataset` 的受限参数(表必须在语义资产白名单内,列/聚合由 guard 校验)。即:LLM 提路径,协议决定能不能走(DataBuddy 原则)。

### Q2.7 「口径一致下钻」怎么实现?(核心差异化能力)
北斗导出里有完整的指标口径:**caliber.formula(JSON AST:BIN_OP/CALL_OP/NAME_REF/CONSTANT)+ filters(DSL 文本)+ 数据集列→物理列映射(lineage_summary.physical_column_to_dataset_column)**。
实现 **MetricSqlCompiler**:`formula AST → SQL 表达式`、`filter DSL → SQL 谓词`、数据集列名 → 物理列名替换、自动注入 metricTime 时间过滤与维度 GROUP BY。产物 = CTE 口径一致 SQL,过 guard 执行。**任何一步解析失败即拒绝下钻该指标(fail-closed),提示走人工路径**——继承售后项目「model_generated_sql_forbidden 精神」:下钻 SQL 由编译器生成,不是 LLM 自由发挥。

### Q2.8 SQL 护栏策略?
双层:①**编译器层**:下钻 SQL 只能由 MetricSqlCompiler 从口径生成;②**guard 层**:TS 实现 tokenizer(剥离字符串/注释后 token 分析)——单语句、仅 SELECT/WITH/SHOW/DESC/EXPLAIN 开头、禁词黑名单(INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT/...)、强制/收紧 LIMIT、表白名单(必须在语义资产中)、敏感列拦截、超时与行数上限。数据库侧兜底:强制只读账号。**parse 不了就拒绝(fail-closed)**。
(sqlglot 属 Python;MVP 用 TS tokenizer 版,严格性靠「白名单表+只读账号+关键词黑名单+token 级分析」组合保证;后续可加 sqlglot sidecar 加强,见 Q7.3。)

### Q2.9 指标平台的接入方式?
双模式:**本地模式**(默认,离线可用)——语义检索全部来自导入的本地 JSON;**在线模式**——查数值走 AnyMetrics `queryMetrics` 风格 API(会话内已有该 API 的 MCP schema 作为参照,认证用三 header:tenant-id/auth-type/auth-value)。MVP 先做:元数据本地 + 数值查询在线;在线不可用时明确告知(如实披露 gap,不硬编——售后项目教训)。

### Q2.10 workspace(工作空间)是什么?
一个目录,含:
```
workspace/
├── config.yaml          # 数据源/模型连接配置(含密钥引用)
├── semantics/
│   ├── import/          # 北斗导出原样 JSON(metrics/details/dimensions/tree/lineage_summary)
│   ├── glossary.yaml    # 术语/同义词(人工维护,权威源)
│   └── bindings.yaml    # 数据集→物理表绑定覆写(可覆盖导入值)
├── skills/              # 技能(SKILL.md,Anthropic 格式,Agent SDK 从 cwd 自动加载)
├── audit/audit.jsonl    # 审计(派生物,但只追加)
└── index/               # 派生索引(可整目录删除重建)
```
多 workspace 支持(MVP 单 workspace,UI 可切换目录)。

## S3 模块与代码组织

### Q3.1 目录结构?
```
app/
├── docs/                # SPEC / ARCHITECTURE / CODE_STANDARDS
├── src/
│   ├── core/            # 纯 TS,零 electron 依赖,100% 可单测 ★TDD 主战场
│   │   ├── types.ts     # 领域类型(MetricMirror/DatasetCard/GlossaryTerm/IntentSpec/EvidencePack/AuditEvent...)
│   │   ├── semantics/   # importer(北斗JSON→资产)/ store(索引+检索)/ validate
│   │   ├── compiler/    # metric-sql-compiler(口径→SQL)/ dsl-parse(formula AST/filters DSL)
│   │   ├── guard/       # sql-guard
│   │   ├── router/      # 路由策略(纯函数,给 system prompt 与 UI 共用)
│   │   ├── services/    # anymetrics-client / starrocks-client(依赖注入 fetch/mysql2,便于 fake)
│   │   ├── evidence/    # EvidencePack 组装
│   │   └── audit/       # JSONL writer/reader
│   ├── main/            # Electron 主进程:窗口/IPC/AgentService/McpTools(把 core 组装成 Agent SDK 工具)
│   ├── preload/
│   └── renderer/        # React:Chat/Semantics/Skills/Plugins/Audit/Settings 六页
├── resources/workspace-default/   # 新 workspace 模板(含内置三技能)
└── tests/               # 跨模块集成测试(core 内单测就近放 *.test.ts)
```

### Q3.2 core 的依赖红线?
- `src/core` **禁止** import electron / react / node 专属 API(fs 例外:仅通过注入的接口);目标是未来可复用到 CLI/服务端。
- 所有外部 IO(fetch、mysql、fs)以接口注入,测试用 fake。

### Q3.3 测试策略(TDD 执行方式)?
- 顺序:先写 `*.test.ts`(覆盖用例来自:北斗真实数据样例、SQL 攻击样例、口径编译金标),红 → 实现 → 绿 → 重构。
- 层次:`core` 全量单测;`main` 的 McpTools 用 Agent SDK fake query 的集成测试(electron 不启动);一条 e2e 冒烟(Headless:mock 数据源跑通 S1.4 三问)。
- 契约测试:内置技能 SKILL.md、system prompt 路由协议、guard 白名单,都有对应断言测试(学售后项目「把 YAML 当代码测」)。

## S4 交互与 UI

### Q4.1 界面结构(仿 DataBuddy 工作台)?
左侧导航:**对话 / 语义 / 技能 / 插件 / 审计 / 设置**;对话页:消息流(支持表格/代码块渲染)+ 右侧证据面板(当前回答的 EvidencePack:指标、口径、SQL、行数、耗时、血缘链)+ 底部输入框(带路由提示 chip:指标/明细/澄清)。语义页:三 Tab(指标 / 数据集与表 / 术语),顶部「导入北斗导出目录」按钮。技能页:技能卡片(名称/描述/启停)+ 编辑器。插件页:数据源卡片(StarRocks/AnyMetrics)+ 连接测试按钮 + 模型配置。

### Q4.2 证据怎么呈现?
每次工具调用产生 EvidenceItem,回答下方折叠展示「口径卡」:指标中文名+业务口径+公式 SQL(可复制)+ 物理表 + 行数/耗时 + 血缘链(指标←数据集←物理表)。

## S5 风险与开放问题

### Q5.1 已识别风险?
1. DeepSeek 端点忽略部分 Anthropic 字段、偶发 tool-call 纯文本 bug → 工具结果自校验 + flash 优先;
2. StarRocks 生产连接安全 → 默认不填真实连接也能跑(mock 模式),真连接必须只读账号;
3. 口径 DSL 解析覆盖不足 → fail-closed + 明确列出「可下钻指标」清单;
4. Agent SDK 版本迭代快 → 锁版本,封装薄适配层 `src/main/agent/sdk-adapter.ts`。

### Q5.2.0 mock 边界(v0.4.0 确立,用户指令)
**mock 只覆盖语义本体(演示语义包=北斗全量导出)与数据值(mock 连接器);产品能力与框架必须全真实**——LLM 驱动的 Agent 环路、口径编译(含跨数据集维度 JOIN)、护栏、审计、多空间、RBAC、IDaaS 登录、术语/技能/导入的 UI 管理全部是真实实现,不因演示模式降级。

### Q5.2.1 mock 演示数据模式(v0.3.1 已实现)
未配置 StarRocks 且未显式关闭(starrocks.mock: false)时,启用确定性 mock 连接器(core/services/mock-starrocks):按 SQL 形态(SELECT 列/GROUP BY/LIMIT)生成数据,SQL 哈希做种子保证同问同答;**诚实标注是硬约束**——工具层在结果 JSON 与 EvidenceItem 上标记 dataSource:mock / mock:true,UI 顶栏显示「演示数据(mock)」标签,证据面板逐条带 mock 标。配置真实 host 后自动切真实数据。

### Q5.2 开放问题(随实现追加)?
- [ ] AnyMetrics 在线数值查询 API 的确切契约(先按 dip-vap-metric-query 的 queryMetrics schema 实现,联调时校正)
- [ ] 敏感列清单初始来源(guard 已留配置位)
- [ ] 是否需要会话持久化恢复(MVP:重启丢会话,先不做)

---

## S6 多空间、登录与角色权限(v0.2,2026-09-18)

> 产品定名「北斗work」。参考 DataBuddy 官方文档(平台管理/权限/Buddy 分组,约 230 篇侧栏结构经核实)。

### Q6.1 多工作空间怎么建模?资产如何隔离?
DataBuddy 的做法:空间是协作/成员边界,Catalog(元数据湖)跨空间共享;「分析空间」只引用不复制资产,空间角色与资产权限是两套体系。
**定(三层隔离,文件优先)**:
1. **文件层**:每空间一个独立目录(userData/spaces.json 注册表管理;新建/切换/导入/移除,移除不删数据)。空间内 semantics/、skills/、members.yaml、scope.yaml、audit/ 完全独立,天然可 Git 管理;
2. **资产层**:`semantics/scope.yaml`(包含过滤器:metricNames/categoryPaths/datasets/tables,并集)→ `filterAssets` 过滤语义资产——对应 DataBuddy「分析空间只引用不复制」的简化版;
3. **查询层**:guard 白名单从过滤后的 store 派生——空间外物理表在物理上就查不到。
坏 scope 文件 → 告警 + 不过滤(空间所有者修复),不炸应用。

### Q6.2 登录方案?
用户指定「飞书登录,对接北斗鉴权」。核实:公司统一身份 = 理想 IDaaS(飞书扫码);本机 ept 工具链的登录态在 `~/.config/ept/auth_session.json`(access/refresh/id_token + account);**北斗 AnyMetrics 的 API 鉴权就是 UID(auth-value=账号名)**。
**定(v0.2 复用,v0.3 自建)**:
- v0.2:启动时读 ept 会话 → `identityFromEptSession`(JWT 解 nickname,fail-closed)→ 身份 {username,name,email};过期提示重新 `ept login`;
- v0.3(待办):内置 IDaaS OAuth 设备码/浏览器流,摆脱对 ept 的依赖;拿 UID 后调 AnyMetrics 拉取「该用户有权限的指标」自动生成空间 scope(权限即资产)。

### Q6.3 不同角色看到的菜单和权限如何管理?(用户明确要求好好想)
DataBuddy 的做法:**三层权限模型**——①平台级(控制台管理员/成员)②工作空间级(空间管理员/成员/**自定义角色**,自定义角色=按菜单页面逐项勾选读/写/删权限点)③对象级 ACL(可管理>可编辑>可运行>可查看+可使用);无权限菜单**不渲染**、无权限按钮置灰+hover 提示、无 ACL 资产从列表隐藏;实际权限=直接授权∪用户组继承;不支持按用户粒度只能按角色。
**定(双层防线 + 空间成员文件)**:
- 角色四档(与 DataBuddy 空间角色映射):`admin`(≈空间管理员)/`engineer`(≈自定义开发角色)/`analyst`(≈分析成员)/`viewer`(默认);
- **权限矩阵集中在 `core/rbac/rbac.ts`**(menus + perms 两张表,契约测试锚定),菜单 key 与 App.tsx 对齐;
- 空间成员:`members.yaml`(default_role + username→role;未列出登录用户走 default_role);
- **UI 层**:主进程在 workspaceState 里下发 role+menus,菜单不渲染(无权限即不可见);
- **执行层(关键)**:写操作(config:save/members:save)与查询(agent:send)在 **IPC 主进程再校验** `can(role, perm)`——菜单隐藏不是安全边界,主进程校验才是(对应 DataBuddy「UI 与 ACL 两套」精神);
- v0.3 候选:对象级 ACL(资产白名单五档)、用户组继承、按维度值范围的行级权限(DataBuddy 指标授权附带维度范围)。

### Q6.4 打包分发?
**定:electron-builder → mac dmg(arm64,ad-hoc/无签名,本机可装)**;`npm run dist` 一键出包。签名/公证后续接公司证书。GitLab 公共仓后续提交(本地 git 已管理)。

### Q6.5 涉及模块?
`core/identity`(身份)、`core/rbac`(角色与权限矩阵)、`core/spaces/scope`(资产隔离过滤)、`main/spaces`(注册表)、`main/workspace`(装载 scope+members)、`main/index`(身份/空间/成员 IPC + 主进程权限校验)、渲染层(空间切换下拉、身份芯片、菜单过滤、成员管理页)。

---

## S7 数据分析 MVP 定稿(v0.5,2026-09-18,用户指令)

> **不做数据开发功能模块**(接入/ETL/工作流/建仓),MVP 只做**数据分析能力**;核心场景是**业务智能化诊断与归因**。

### Q7.1 空间 = 业务域,里面有什么?
空间目录即业务域容器,资产分层(全部文件、可 Git 管理、随空间隔离):
| 层 | 内容 | 载体 |
|---|---|---|
| 子业务域 | 北斗类目树(智能驾驶/智能空间/…)+ scope.yaml 裁剪 | semantics/import/tree.json + scope.yaml |
| 实体/业务模型 | 轻量语义资产(实体→维表/主数据;业务模型=指标组合+实体+关注维度) | semantics/entities.yaml(YAML,非 RDF) |
| 数据模型 | 数据集→物理表→列绑定 | semantics/import(北斗血缘) |
| 指标/维度 | 北斗 390 指标镜像 + 口径 | semantics/import |
| 业务知识库 | 业务背景/口径解释/既往结论 | knowledge/*.md(工具 search_knowledge 检索) |
| 业务技能 | Agent 行为约束 | .claude/skills/*/SKILL.md |
| 业务 Playbook | 分析 SOP(如指标异动归因) | playbooks/*.md(工具 read_playbook) |

### Q7.2 智能诊断与归因怎么实现?
**确定性计算与 LLM 解读分离**(延续「LLM 不写 SQL/不算算术」原则):
- core/analysis/diagnosis(TDD):两期总量对比 → 异常检测(阈值+方向)→ 维度贡献拆解(**DataBuddy 贡献算法:contribution_i=(cur_i−prior_i)/prior_total**,新增/消失成员按 0,Top-K+闭合校验);查询走 compileMetricSql 口径编译(含跨数据集维度 JOIN)。
- 工具 diagnose_metric:结构化输出;system prompt 诊断协议:诊断三步(diagnose → search_knowledge → read_playbook)→ 报告四段(结论/归因/业务解释/建议);**归因≠因果,无知识库证据必须写「待业务确认」**。
- 工具从 4 个扩到 7 个(+diagnose_metric/search_knowledge/read_playbook),契约测试同步。

### Q7.3 待完善(排期;v0.6 已完成前四项)
- [x] 知识库检索升级(v0.6:标题/小节加权+段落级摘录;向量检索仍待做)
- [x] 归因维度智能选择(v0.6:业务模型声明维度优先)
- [x] 报告导出(v0.6:Markdown 到空间 reports/;PDF/飞书待做)
- [x] 实体/业务模型进检索(v0.6:search_semantics 命中 entity/model)
- [ ] 诊断多指标关联(指标树:北斗 COMPOSITE 依赖,量化「子指标贡献了多少父指标变化」)
- [ ] 定时巡检(被动问诊 → 主动监控告警)
- [ ] 知识库向量检索 / 语义层注入(DataBuddy 业务文本 ≤3000 字模式)
- [ ] 报告导出 PDF / 飞书文档

---

## S8 界面设计语言(v0.7,2026-09-19;参考 dataelement/dsh-desktop)

> 参考结论:dsh-desktop 的 UI = 上游 DeepSeek Harness 客户端(40 个 dsh-client-ui-* 模块);我们采纳其设计语言自研实现。

### Q8.1 布局骨架?
**细图标栏(56px)+ 二级面板(248px,会话列表)+ 主内容区 + 右侧证据面板(330px)**。
图标栏:渐变 Logo(BW)→ 六个模块图标(Tooltip,激活态左侧指示条,按角色过滤)→ 底部身份头像(登录/主题菜单)。顶栏:空间下拉 + 资产计数 + 状态胶囊(模型/数据源/角色,带状态点)+ 刷新。会话列表:多会话管理(localStorage 持久化,新建/切换/删除)。

### Q8.2 视觉规范?(styles/global.css,CSS 变量双主题)
- 主色 `#4d6bfe`(深色 `#6b83ff`),hover 加深;背景浅 `#f6f7f9` / 深 `#0f1216`;面板白 / `#171b21`;
- 卡片:1px 边框(8% 黑/白)+ 12px 圆角 + 双层柔和阴影;胶囊 chip 24px 高带状态点;
- 字体:-apple-system/PingFang SC 栈,正文 13.5px;代码/工具名用 mono;
- 聊天:用户消息右侧主色气泡(不对称圆角),AI 消息左侧竖线引用式 + 头像徽标,工具调用为 mono 小胶囊(失败红色态);
- 输入:悬浮卡片式大输入框(聚焦变主色边)+ 圆形发送按钮 + 快捷键提示行;Enter 发送/Shift+Enter 换行/中文输入法合成保护;
- 空态:英雄屏(标题+副标+四张建议卡,点击即问)。

### Q8.3 主题切换?
身份菜单切换浅/深(localStorage `daw.theme` 持久);antd ConfigProvider 双 algorithm + 设计 token(colorPrimary/borderRadius/fontFamily)同步;自研样式走 `[data-theme]` CSS 变量。

### Q8.4 待完善
- [ ] 应用图标(dmg 目前默认 Electron 图标)
- [ ] 消息 markdown 渲染(表格/代码高亮)与会话内 evidence 逐条对应
- [ ] 语义页类目树导航(子业务域左树)

---

## S9 dsh 插件 PoC + 本体模型升级(v0.8 规划,2026-09-19)

> 完整实施方案见 ~/.claude/plans/poc-1-2-binary-magpie.md(已批准);本节记录决策与 schema 定稿。

### Q9.1 为什么做 dsh 插件 PoC?(前期评估结论)
工具层插件化可行且低成本(core 零依赖、ToolContext 全注入、defineTool 一对一);UI 层基于 dsh-desktop 插件化风险高(上游 developer preview、desktop 深定制走 23 个 patch-package 补丁钉死 RC 版本)。**决策:先插件验证(V1-V9),壳后定**(用户已确认)。

### Q9.2 本体 schema 定稿要点(B 节)
domain(服务)→ subdomain(门店经营 store-ops / 用户体验 user-exp)→ topic → class;概念层(class/property/relation/action)与绑定层(bindings)分离;借 RDF/OWL 词汇不借运行时;数据集→表指针(查数连库)、指标→平台引用(调接口)、知识→本地 clone(git);relation.via 存事实表+双侧键;action=诊断 SOP 声明式入口。schemaVersion+version(semver)双版本,CI 校验拦截。

### Q9.3 已确认的卡点决策
F-1 IDaaS 自定义 app_id 允许实测(beidou-desktop/owner,本地留存);F-2 两子域本体=脚本起草+业务定稿;F-3 凭据只存 env 引用;F-7 GitLab 代码/资产分仓(beidou-work / beidou-workspace);F-10 PoC 后决策壳。

### Q9.4 V2 修订(吸收评审 docs/reviews/2026-09-19-dsh-poc-review-v1.md,计划见 docs/plans/poc-dsh-plugin-v2.md)
- 工具目录定版 **10 个**(业务 8 + 身份 2);metricOnline=false 时 query_metrics 走口径编译降级
- **pnpm workspace monorepo**(beidou-core/domain-contracts/ontology-schema/dsh-plugin-beidou 四包),禁止跨仓库相对 TS 源引用;`pnpm dsh:poc` 生成可移植 cordis 配置
- **概念层与绑定层物理拆分**:ontology.yaml(概念,治理字段齐)+ bindings/{datasets,tables,metrics,knowledge}.yaml(指针),双版本独立
- 失败策略定版:本体发布/绑定缺失/权限白名单读取失败=fail-closed;搜索预览=fail-open+告警;知识缺失=降级+证据不足标注
- IDaaS 固定 owner 限定 `auth_mode: single-user-poc`;多用户前置:真实 open_id、用户隔离、租户上下文、Keychain、集中撤销、审计关联身份
- 审计统一事件 Schema(traceId/userId/policyDecision/dataSources/resultCode),AuditSink 接口(Jsonl PoC / Remote 预留)
- 敏感字段(vin/phone)**在工具输出层脱敏**,不依赖模型自觉;Skill 结构化 YAML 定义
- 验收 Gate A(插件基础 V1/V2/V6/V8)/ B(业务闭环 V3/V4/V5)/ C(企业集成 V7/V9,V9 非阻塞待账号);成功标准=完成一个真实诊断任务(门店经营周诊断)
- 实施顺序调整:Phase 0 基线 → 1 空壳 → **2 Ontology 内核** → 3 Mock 闭环 → 4 身份+真实数据 → 5 四壳对比结论

### Q9.5 V2.1 基线定稿(用户终审七点,开发以此为准)
一套 schema 两 subdomain(user-exp=draft);Phase 3 只做 8 业务工具、Phase 4 加 2 身份工具;Gate=A(基础 V1/V2/V6)/B(业务 V3/V4/V5)/**S(安全 V8+安全测试,后置到脱敏管线就绪)**/C(企业 V7/V9);成功标准=真实业务问题+全真链路+受控 Mock;V9 缺失只能标「真实数据集成未完成」;依赖精确锁定(=0.1.5-rc.2)+资产 RELEASE.md 发布清单;脱敏发生在日志/审计/模型输出之前(工具输出管线单点)。旧 entities 模型 Phase 2 一次性移除,不留运行时回退。
