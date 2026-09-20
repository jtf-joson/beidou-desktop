# CHANGELOG

## 0.1.0(2026-09-17)

首个可运行版本(仿 DataBuddy 桌面端核心能力)。

### 交付
- **文档**:SPEC(自问自答)、ARCHITECTURE、CODE_STANDARDS
- **core(TDD,126 测试,行覆盖 93.7%)**:
  - `guard/sql-guard`:token 级 SQL 护栏(六规则,fail-closed,CTE 豁免)
  - `semantics/`:北斗(AnyMetrics)导出导入器 + 语义检索(同义词/中文反包含/打分)
  - `compiler/`:口径 DSL 编译器(formula AST→SQL、过滤 DSL 解析、MetricSqlCompiler 口径一致下钻、嵌套指标 code 解析)
  - `tools/`:受控明细 SQL 构建器 + 四个 Agent 工具(search_semantics / query_metrics / query_dataset / clarify)
  - `router/`:路由策略纯函数 + system prompt(契约测试锚定)
  - `services/`:AnyMetrics 客户端(三 header + 重试)、StarRocks 客户端(sentinel 截断)
  - `evidence/` `audit/`:EvidencePack 组装/脱敏、JSONL 审计
- **桌面端**:Electron + React 六页(对话+证据面板/语义/技能/插件/审计/设置);workspace 模板(config/glossary/三技能)
- **Agent 通道**:Claude Agent SDK + DeepSeek Anthropic 端点(进程内 MCP server);无 key 时降级确定性演示管线

### 验收
- `npm test`:14 文件 126 用例全绿;`npx tsc --noEmit` 通过;`npm run build` 通过
- 桌面应用真实启动冒烟:workspace 模板初始化 ✓、无 IPC 错误 ✓
- e2e:指标问题 → 检索 → 路由 → 口径编译 → 护栏 → 执行 → 带证据回答(北斗真实数据夹具)

### 已知决策
- Agent SDK 仅 ESM,主进程 CJS 打包 → sdk-runner 动态 import(SPEC S5.1)
- 指标在线数值查询契约待联调,SPEC Q5.2 保持开放;当前统一走口径编译

## 0.2.0(2026-09-18)

北斗work:多空间、登录身份、角色权限框架 + mac 安装包。

### 新增
- **多工作空间**:spaces.json 注册表(新建/切换/导入/移除,移除不删数据);三层资产隔离(目录层/scope 资产层/guard 查询层);scope.yaml 包含过滤器(metricNames/categoryPaths/datasets/tables 并集)
- **登录身份**:复用 ept(IDaaS/飞书扫码)会话 → Identity(JWT 解析 fail-closed);过期提示;为 v0.3 内置 OAuth 与「按 UID 拉有权限指标生成 scope」预留
- **角色权限(RBAC)**:admin/engineer/analyst/viewer 四角色;权限矩阵集中可契约测试;菜单不渲染 + 主进程 IPC 二次校验双层防线;空间成员 members.yaml(未登录/未列出 → default_role)
- **UI**:空间切换下拉、身份/角色芯片、菜单按角色过滤、设置页成员管理(admin)
- **打包**:electron-builder → dmg(arm64);`npm run dist`

### 设计依据(SPEC S6,对齐 DataBuddy 官方文档)
- 三层权限模型(平台/空间/对象 ACL)→ 我们取两层(菜单 UI + 主进程执行)
- 分析空间「只引用不复制」→ scope 过滤器
- 无权限菜单不渲染 → menusFor(role)
- OBO(以发起用户身份执行)→ identity 贯穿审计,后续贯穿 AnyMetrics 调用

## 0.3.0(2026-09-18)

北斗 IDaaS 登录(内置)+ 真实 LLM 链路验证。

### 新增
- **IDaaS 认证**(协议来自 ~/.codex/skills/idaas-auth-protocol v1.0.4,替代 ept 依赖的正规方案):
  core/auth/idaas.ts(TDD 8 用例):创建会话→login_url→轮询→token-file 下载→原子缓存(app_id+open_id,600 权限);
  主进程 auth:state/login/refresh IPC(登录链接先开浏览器再轮询);身份优先级 = IDaaS token > ept 会话 > 未登录;
  UI 身份菜单含「北斗 IDaaS 登录(飞书)/刷新登录态」;config.yaml auth 段(app_id 必填,服务默认 idaas-auth-protocol-service.inner.example.com)
- **真实 LLM 链路验证**(tests/manual/llm-smoke.test.ts,DATA_AGENT_LLM_SMOKE=1 触发):
  DeepSeek(deepseek-flash[1m],Anthropic 端点)驱动 search_semantics → query_metrics → 口径编译 SQL → 护栏 → 执行,
  产出带口径与证据的中文结论;修复 SDK 事件流解析(tool_result 层级、最终文本回落)
### 说明
- DeepSeek key 配置在应用工作区 config.yaml(userData,不入 git);旧 token 可经 auth-service 刷新

## 0.3.1(2026-09-18)

mock 演示数据场景(MVP 验收缺口 A-4 补齐)。

- core/services/mock-starrocks:确定性演示数据连接器(SQL 哈希种子、按 SELECT/GROUP BY/LIMIT 形态生成、日期列出日期序列);复用 guard tokenizer 解析
- 未配置 StarRocks 时默认启用;starrocks.mock: false 可关;配置 host 自动切真实
- 诚实标注三处:工具结果 JSON dataSource+警告 note、EvidenceItem.mock、UI 顶栏「演示数据(mock)」标签与证据面板 mock 标
- e2e 新增 mock 全链路(出数+标注)与确定性两用例;共 167 测试

## 0.4.0(2026-09-18)

确立边界:**mock 只覆盖语义本体与数据值,产品能力与框架全真实**(用户目标)。

### 新增(真实产品能力)
- **跨数据集维度下钻**:dimXxx_df_col 形态平台维度自动解析维表绑定,编译器生成 LEFT JOIN(join key 默认 vin,可配),主表列自动加别名限定防歧义;DSL 支持限定标识符(t.col);3384 个平台维度由此可下钻
- **演示语义包**:resources/demo-semantics(北斗全量导出 390 指标/65 数据集/67 表);新空间首次初始化自动载入——开箱即有完整语义本体
- **语义导入 UI**:语义页「导入北斗导出目录」+「载入演示语义包」按钮(engineer+)
- **术语 CRUD**:术语页可增删改保存(结构校验 + semantics:edit 权限双防线),保存即检索生效
- **技能启停/编辑/新建**:Switch 启停(目录改名 .disabled,不删数据)、内容编辑、新建技能(skills:manage 权限)
### 验证
- 171 测试全绿;真机全新初始化:390 指标自动载入、维度解析(车型)与检索正常

## 0.5.0(2026-09-18)

数据分析 MVP 定稿:聚焦智能诊断与归因(不做数据开发模块)。

- **诊断引擎**(core/analysis,TDD 8 用例):两期对比→异常检测→维度贡献拆解(DataBuddy 贡献算法,新增/消失成员按 0,Top-K+闭合校验)
- **新工具 ×3**:diagnose_metric(结构化归因)、search_knowledge(业务知识库检索)、read_playbook(分析 SOP);工具共 7 个,system prompt 增诊断协议与知识库/Playbook 清单注入
- **空间业务资产**:knowledge/*.md、playbooks/*.md、semantics/entities.yaml(实体+业务模型,轻量 YAML);新空间自动初始化示例;语义页新增 实体与模型/知识库/Playbook 三个 Tab(带权限编辑)
- e2e ×2:诊断全链路(mock 数据真实能力)、知识库/Playbook 命中与未命中;共 181 测试

## 0.6.0(2026-09-19)

S7.3 排期第一轮完善:实体模型进链路、诊断维度智能化、知识库检索升级、报告导出。

- **实体/业务模型进检索与诊断**:entities.yaml 结构化解析(TDD);search_semantics 命中实体(entity)与业务模型(model,带关注维度);diagnose_metric 归因维度智能选择——显式 dims > 业务模型声明维度 > 指标自身维度前 4
- **知识库检索升级**:标题/小节加权(小节×5、文件名×3、正文×1)+ 命中段落定位摘录(替代开头 600 字截断)
- **报告导出**:证据面板「导出报告」按钮 → 组装 md(问题/结论/证据含口径/SQL/血缘/mock 标记)存空间 reports/
- e2e ×2 新增(实体命中、模型驱动维度);193 测试

## 0.7.0(2026-09-19)

界面全面重设计(参考 dataelement/dsh-desktop = DeepSeek Harness 客户端设计语言)。

- 布局重构:56px 细图标栏(渐变 Logo/模块图标/身份)+ 248px 会话列表面板 + 居中会话流 + 右侧证据面板;顶栏空间下拉 + 资产计数 + 状态胶囊
- 设计系统 styles/global.css:CSS 变量双主题(浅/深),主色 #4d6bfe;卡片/胶囊/气泡/工具chip/输入卡全套组件类;自定义滚动条
- 聊天体验:英雄空态 + 建议卡;用户主色气泡 / AI 引用式消息 + BW 徽标;工具调用 mono 胶囊(成败态);悬浮卡片输入(自动增高、Enter 发送、中文合成保护)
- 多会话管理(localStorage 持久化:新建/切换/删除/时间分组显示)
- 深浅主题切换(身份菜单,antd 双 algorithm + data-theme 变量联动)
- 各功能页卡片化(daw-card);DEBUG 截图钩子(DDAW_SCREENSHOT/DDAW_THEME,真机截图验证浅/深两套)
- 193 测试不受影响全绿;dmg 0.7.0

## 0.8.0(2026-09-19)

Code review 修复(15 条发现全处理)+ Phase 0/1 补记。

### 崩溃级修复
- **preload 桥**:暴露全部 35 个 DawApi 方法(此前 13 个缺失致语义/技能/导出报告页崩溃)
- **IDaaS mkdir**:writeFileAtomic 补建父目录(auth/apps/…,修复全新机器首次登录 ENOENT)
- **query_dataset schema**:SDK 端 zod 补齐 drilldown/expore 全部参数(此前仅 mode,模型传参被剥离致下钻不可用)
- **ChatPage busy 卡死**:非活跃会话 done/error 也重置 busy;切会话/新建时防御性重置
- **会话持久化**:sessions useEffect 写回 localStorage(此前只读不写,切页/重启丢历史)
- **glossary 种子路径**:ensureWorkspace 种到 semantics/(与读取一致,修复新空间术语空转+根目录死文件)

### 数据完整性
- spaces:remove 最后一个空间守卫(拒绝并返回错误)
- persistRegistry 串行化(防并发 O_TRUNC 交错损坏 spaces.json)
- SDK error result 不伪装正常回答(is_error/subtype 检查→onEvent error)
- tool_result 事件读 isError(修复 LLM 模式下失败被报成功+审计失真)
- beidou 导入缓存(文件签名不变则复用,glossary 保存不再重 parse 8.6MB)

### 工程门禁
- 覆盖率门禁恢复:beidou-core 补 @vitest/coverage-v8 + test:coverage 脚本;desktop 补 coverage include(阈值 50%);根 test:coverage 聚合
- llm-smoke 夹具路径修正(→ packages/beidou-core/test-fixtures/)
- tsconfig paths 修正(@beidou/core/src/* 映射);vitest alias 改 regex 锚定
- probe 脚本重写:进程组 kill(detached+SIGTERM/SIGKILL)、beidou 行级 loader 错误判定(不误报)、cwd 无关(root 绝对路径)、显式 process.exit
- 死代码清理:workspace.ts 死 metricsByCode、smoke.test.ts 未用 import+any cast

### Phase 0/1 补记(此前遗漏)
- Phase 0 monorepo 迁移(a74353b):npm workspaces 拆包(beidou-core/domain-contracts/apps/desktop);183+10+2 测试全绿;dmg 构建通过
- Phase 1 dsh 插件空壳(713d5fe):V1 PASS(cordis 插件装载+beidou_ping)

## 0.9.0(2026-09-19)

Phase 2:Ontology V1(schema+parser+validator+bindings+list_ontology 工具)。

- **packages/ontology-schema**(TDD 19 用例):parseOntology(fail-open)/validateOntology(fail-closed:extends 环/子域引用/topic/key/重复 ID/relation 悬空/action 悬空/schemaVersion 校验)/loadBindings(datasets/tables/metrics/knowledge 四指针文件)/migrateEntities(旧→新草稿)
- **list_ontology 工具**(第 8 个业务工具):按子域返回 class/property/action/绑定表指针结构
- **search_semantics 命中扩容**:本体 class(名称/描述/属性)、relation、action 带子域归属进入候选
- workspace 装载 ontology.yaml + bindings/*.yaml(fail-open,warning 不阻断)
- e2e ×2:list_ontology 结构化输出 + search 命中本体 class
- 214 测试全绿(core 183 + ontology 19 + desktop 12)

## 0.9.1(2026-09-19)

外部 code review(GitHub 公开快照)P0 修复:5 项阻断问题全清。

### P0-2 config:read 凭据脱敏
- 渲染层读取 config.yaml 时 auth_token/password/auth_value/service_token 替换为 ***
- config:read 增加 config:save 权限校验(engineer+)

### P0-3 过期身份不再保有角色
- currentRole() 统一检查 isExpired;过期身份走 defaultRole(viewer),不映射成员角色

### P0-4 skills:toggle 路径穿越修复
- 复用 skills:save 的 /^[A-Za-z0-9_-]+$/ 名称校验,阻断 ../../ 穿越

### P0-7 工具层审计真实落盘
- AgentDeps 增加 auditSink 接口;buildAgentService 注入 createAuditLog → workspace/audit/audit.jsonl
- tool_call/tool_result/guard_rejection/agent_reply 全量经 auditSink 写入

### P0-1 SQL Guard 三项加固(+2 回归测试)
- 逗号+别名表检测:FROM allowed a, secret b 现可检出 secret(FROM 后跟别名再逗号的场景)
- EXPLAIN/DESC 表不再跳过白名单:EXPLAIN SELECT * FROM evil.table 被拒绝;SHOW(无表引用)仍放行
- SELECT * + 敏感列配置 → 拒绝(无法验证 * 不含敏感列)
- 新增回归测试:comma+alias、SELECT * + sensitive

## 0.10.0(2026-09-19)

Phase 3:8 业务工具全量接线 dsh 插件(V1 PASS with tools)。

- dsh-plugin-beidou 升级为 Phase 3:8 个业务工具全量注册(search_semantics / query_metrics / query_dataset / clarify / diagnose_metric / search_knowledge / read_playbook / list_ontology)
- context.ts:ToolContext 组装(loadWorkspace + mock/mysql 连接器 + 真实 auditSink);workspace 路径从 BEIDOU_WORKSPACE 环境变量获取
- adapter.ts:统一 output schema(ok/text/error)+ render;toolDef 泛型包装
- esbuild 打包链(scripts/build-plugin.mjs):bundle TS→单文件 JS(423KB),解决 dsh ESM loader 不认 TS 扩展名 import 的问题(= 评审 P0-3 "引用稳定产物")
- `npm run dsh:poc` 现在自动:plugin:build → generate-cordis-config → dsh web --patch
- 199 测试全绿(185 core + 12 desktop + 2 contracts);V1 PASS(8 工具装载 + HTTP + 无 loader 错误)

## 0.11.0(2026-09-20)

外部 code review(ccfb2dd)P1 七项修复 + P0 三项。

### P1 修复(Phase 3 工具完整性)
- P1-1 apply() 改同步+内联 async(带错误传播,非静默;Cordis 不 await async apply)
- P1-3 移除虚假 "system prompt injected" 日志(Phase 4 接入)
- P1-5 工具参数补齐:query_metrics+timeRange / query_dataset+dims+timeRange+aggregates+where+groupBy+orderBy / diagnose_metric+timeRange+dims+thresholdPct
- P1-6 tsconfig paths 统一为 @beidou-core/*
- P1-7 yaml 加插件直接依赖
- dsh DSL 硬约束补全:全参数 required:true / object 类型必须显式 additionalProperties / output schema error 必须 required(4 个新 DSL 发现)

### P0 修复
- P0-6 sessionId 动态生成(dsh-${timestamp}-${random})
- P0-3(部分)config:save 密钥覆盖风险待修(需要结构化编辑方案,Phase 4)

### 工程改进
- P2-1 dsh:probe 自动 plugin:build → generate-cordis-config → probe
- probe 检查改为 "8 business tools registered"(实际工具注册成功)

## 0.12.0(2026-09-20)

Phase 4:身份工具 ×2 + connection-router + 遗留 P0 修复。

- **beidou_login / beidou_auth_status**:IDaaS 登录(登录链接→浏览器确认→token 本地 ~/.beidou/auth/);app_id=beidou-desktop, open_id=owner, single-user-poc
- **connection-router**(core, TDD 6 用例):四级路由(精确表 > schema 前缀 > dataset 卡片 > default);未命中拒绝
- **P0-2 修复**:effectiveIdentity() 统一 isExpired 检查,过期身份 → 匿名 → defaultRole
- **P0-4 修复**:SDK env allowlist(PATH/HOME/LANG/TERM + 模型变量,不传全量 process.env)
- V1 PASS:8 business + 2 identity tools(10 个工具)
- 205 测试全绿(191 core + 12 desktop + 2 contracts)

## 0.13.0(2026-09-20)

外部 code review(d3a4790)P0/P1 修复。

- **P0-1** beidou_login 补 completeLogin 后台轮询(token 自动保存;最长 5 分钟;成功/失败 console 输出)
- **P0-3** Connection Router 改 true fail-closed:错误 Binding 立即拒绝(ROUTE_BINDING_PROFILE_NOT_FOUND);无显式 default 拒绝(ROUTE_NO_DEFAULT;不用 profiles[0])
- **P1-7** token 原子写 rename 失败抛错 + 清理 tmp + 写后校验
- **P1-8** isExpired 非法 expiresAt 视为已过期(fail-closed)
- **P1-9** 匿名(未认证/过期)固定 viewer;defaultRole 只给已认证用户
- Router 测试 7 用例(+2 fail-closed 回归);192 core 测试全绿;V1 PASS(10 tools)

## 0.14.0(2026-09-20)

Phase 4 闭环:Identity 贯穿 + AuthStore 统一 + 多 Profile 接线。

- **P0-6**:Desktop auth 路径统一为 ~/.beidou/auth(与 DSH 共用同一 token 文件)
- **P0-5**:ToolContext 增加 identity 字段;Desktop AgentService 从 effectiveIdentity 注入;DSH 插件从 IDaaS token 缓存读取并注入
- **P0-2(准备)**:context.ts 解析 config.connections 多 profile(与 connection-router 对接的输入);单连接场景向后兼容
- 192 tests;V1 PASS

## Phase 5 完成(2026-09-20)

四壳对比报告 + F-10 决策建议(docs/plans/phase5-shell-comparison.md)。

**结论**:北斗work Electron 为主壳,dsh 插件为能力分发通道。
- UI 可扩展性:北斗work ⭐⭐⭐⭐⭐ vs dsh Web ⭐⭐(client-ui 无开放 API)
- 安全:北斗work ⭐⭐⭐⭐(SQL Guard+RBAC+空间隔离)vs dsh(bash/fs 默认全开)
- 升级:北斗work ⭐⭐⭐⭐(core 零依赖)vs dsh-desktop ⭐(23 个 patch 不可持续)
- 工具轨迹:dsh ⭐⭐⭐⭐(内置 Trajectory)——值得北斗work 借鉴
- 会话管理:dsh ⭐⭐⭐⭐(checkpoint/resume/fork)——北斗work 需补

## 0.15.0(2026-09-20)

第四轮外部 review(GitHub main@459f846)P0 四项代码级 bug 修复。

- **P0-01** DSH 身份注入:真正读取 ~/.beidou/auth token 文件(此前 readFile 固定抛 "no cache" 致 identity 永远不生效)
- **P0-03** resolveRole 增加 authenticated 标志;未认证 → 固定 viewer;defaultRole 只给已认证用户(core 层修复)
- **P0-04** idaas.ts cachedToken 非法过期时间 = 过期(fail-closed,与 identity.ts 对齐)
- **P0-05** Desktop token 原子写 rename 失败抛错 + 清理 tmp(与 DSH 版本对齐)
- 192 core + 12 desktop = 204 测试

## 0.16.0(2026-09-20)

P0 桌面端体验三件套(会话持久化/Markdown/工具轨迹)+ P1 dsh 插件协议单轨与 systemPrompt。

### P0:会话持久化 + Markdown 渲染 + 工具轨迹(北斗work 桌面端)
- **会话持久化(JSONL,文件即权威源)**:core 新增 `session/`(SessionStore 追加式 JSONL + replayEvents 回放 + bubblesToEvents 迁移 + agentEventToSessionEvent 共享映射);主进程 agent 事件流全量落 `<workspace>/sessions/<id>.jsonl`,恢复=回放(与渲染端实时 reducer 同一条代码路径,不存快照);renderer 旧 localStorage 会话一次性迁移入盘;会话按空间隔离(惰性路径,修复 registerIpc 早于 bootstrapSpaces 的时序);单行损坏容忍 + sessionId 白名单防目录穿越
- **Markdown 渲染**:marked(GFM+breaks)+ DOMPurify 白名单净化;表格/代码块/引用/列表全样式(深浅主题适配);正文气泡不再 pre-wrap
- **工具轨迹视图**:工具 chip 升级为可折叠轨迹(步数/状态点:执行中脉冲·成功·失败/摘要/入参 JSON 展开),替代旧纯文本 chip;错误事件落气泡内红色横幅(此前静默丢失)
- **修复**:monorepo 迁移后主进程运行时 require @beidou/ontology-schema 失败(vite 未排除外部化 + 别名缺失)——`npx electron .` 自 Phase 2 起实际无法启动,现一并修复并用 DEBUG 截图钩子真机验证(深浅双主题 × 种子会话回放)
- core +12 测试(回放同构/迁移 round-trip/穿越防护/损坏行);252 测试全绿

### P1:协议单轨(BeidouToolResult)+ systemPrompt(dsh 插件)
- **协议层四件套**(packages/dsh-plugin-beidou/src/):errors.ts(自然语言错误→12 契约错误码,括号内裸码直通)/ schemas.ts(BEIDOU_RESULT_SCHEMA,dsh DSL 全必填+object 显式 additionalProperties)/ policy.ts(业务工具未登录→deny AUTH_REQUIRED;身份工具放行)/ telemetry.ts(AuditEventV2:时长/结果码/策略裁决/traceId,成功/失败/抛错三路径都有事件,遥测落盘失败不阻塞)
- **adapter 重写为单轨唯一边界**:core ToolResponse → BeidouToolResult(ok/code/message/data/warnings/evidence/traceId);mock 证据→warnings 显式提示;8 业务工具 + 2 身份工具全部切换;旧 {ok,text,error} 双轨废止
- **systemPrompt 注入**:ctx.systemPrompt.section("beidou-work:protocol", order=TOOLS_SDK-500)注入路由协议+空间资产清单(修掉 Phase 3 的 `void buildPluginPrompt` 占位);inject 增加 systemPrompt
- 插件新增 vitest(15 用例:错误归类/策略/转换/遥测);V1 PASS(重打包后真机验证;修复 data 字段缺 additionalProperties 的 DSL 硬约束)

## 0.16.1(2026-09-20)

第五轮外部 review(main@8ec3e6b)第一批 P0 修复:密钥回写/动态身份/登录 Result/过期 fail-closed/导航边界。

- **P0-07 config 密钥回写覆盖(桌面端,最高危)**:config:read 掩码(`***`)→ config:save 原样回写会把真实密钥永久变成字面量 `***`;新增 config-merge.ts restoreMaskedSecrets——提交文本中被掩码的行按 key+缩进从磁盘原文一一还原(同名 key 按顺序对应,原文无对应则保留提交值),save 前执行
- **P0-01 DSH 身份启动快照(插件)**:删除启动时一次性读 token 的快照;新增 identity-provider.ts createIdentityProvider(复用 core cachedToken 校验),wrapTool 每次工具调用现读 token——beidou_login 成功落盘后无需重启即生效;同时修掉过期窗口写反(`> now-5min` 会放行刚过期的 token,该判断随快照一并删除)
- **P0-02 登录失败记成功(插件)**:completeLogin 返回 Result(ok:false 是常规失败不抛异常),原 `.then()` 一律记 success;抽出 settleLoginResult 显式分支落 LoginTaskState(polling/success/failed+error),beidou_auth_status 附最近登录任务状态(与日志口径一致)
- **P0-08 cachedToken 非法/缺失 expires_at fail-open(core)**:0.15.0 声称修过但实际仍 `NaN→未过期`;现在缺失/无法解析/距过期不足 5 分钟一律视为过期(fail-closed),插件动态身份与桌面端 auth:state 同享该修复
- **P0-06 主窗口导航边界(桌面端)**:setWindowOpenHandler 一律 deny + 仅 http(s) 经 shell.openExternal 放行(file:/javascript:/自定义 scheme 全拒);will-navigate 只允许应用自身 origin(dev server/打包产物),其余 prevent;禁 webview;index.html 加 CSP(script/img/font 限 self,外链图片随之失效;ws 仅限 localhost dev HMR),顺手把标题从 DataAgent Workbench 改为 北斗work
- 测试:core 206(+3:非法/缺失/刷新窗口过期)+ 插件 24(+9:动态身份 null 覆盖快照/同会话身份变化即时生效/Result 分支/provider 映射)+ 桌面 18(+6:掩码还原);类型检查零错误;插件 dist 重打包;Electron 真机冒烟(深色主题截图验证 CSP/导航改动无回归)

## 0.16.2(2026-09-20)

安装版实测两 bug 修复 + 模型配置菜单(对齐 dsh-desktop)。

- **模型配置菜单(设置 → 模型)**:结构化表单(Base URL / 模型名 / API Key 只写不读)+「测试连接」(Anthropic 协议 /v1/messages max_tokens=1 探活,区分 key 无效/端点错/超时);model-config.ts 结构化读写 config.yaml model 段(留空=保持现有 key,不走 `***` 掩码回写);model:save 后重建 AgentService 即时生效;key 优先级 auth_token > 环境变量
- **修 bug 1「问什么都固定回答」**:根因=安装版(Finder/Dock 启动)读不到 shell export 的 DEEPSEEK_API_KEY → modelConfigured=false 走 mock 演示管线;现在设置页直接填 key 即可,彻底摆脱 GUI 环境变量限制;对话页未配置时显示显式警告横幅(演示模式说明 + 跳设置入口)
- **修 bug 2「第一个对话永远转圈」**:两个叠加原因——(a) SessionStore.append 并发 appendFile 在线程池乱序落盘(审核 P1-05 实证:user_message 落到占位 assistant_chunk 之后),回放时占位块清空上一轮正文,空文本气泡渲染永久 Spin;现在按会话串行写队列(提交序=落盘序)+ 回放跳过空 assistant_chunk(旧乱序文件止血)+ mock 管线不再发空占位事件(tool_call 自建气泡);(b) Spin 渲染条件收紧为「最后一个气泡且 busy 中」,历史空气泡不再显示加载态
- DEBUG 截图钩子支持 DDAW_PAGE=settings(侧栏按钮加 data-page)
- 测试:core 208(+2:并发保序/空块不清空正文)+ 桌面 23(+5:model-config 读写合并/token 优先级)

## 0.16.3(2026-09-20)

安装版配置 key 后对话报错修复(打包态 Agent SDK 可执行文件定位)。

- **根因**:Claude Agent SDK 拉起平台原生二进制(optionalDependency `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,214MB bun 编译)作为子进程;打包后位于 app.asar 归档内,子进程无法执行归档内文件(ENOENT)→ `error_ai_sdk_error`。测试连接走主进程 fetch 不经此路径,故能成功
- **修复**:electron-builder asarUnpack 解出 SDK 平台包为真实文件;sdk-runner 打包态经 `pathToClaudeCodeExecutable`(SDK 官方选项)显式指向 `app.asar.unpacked/.../claude`,dev 态回退 SDK 默认解析
- **验证**:DEBUG 钩子新增 `DDAW_SEND="问题"`(主进程端到端直跑一轮,事件流打日志);打包产物实测:真实 DeepSeek 调用 → search_semantics 工具 → 语义感知回答 → evidence → done 全链路成功
- 注意:安装后目录因解出的原生引擎增大约 214MB(dmg 压缩后体积基本不变)

## 0.16.4(2026-09-20)

第六轮审核(main@964f142)第一批 P0 修复。

- **P0-01 串行队列在主进程实际路径失效**:core 的按会话写队列是实例字段,而主进程 sessionStore() 工厂每次调用都 new 新实例——每个事件各拿空队列,乱序问题在生产路径并未修复(单测同实例掩盖了这一点)。修:session-store-factory.ts 按目录缓存实例(空间切换自动重建);回归测试覆盖"每次 append 都重调工厂"的真实调用姿势(30 并发保序)
- **P0-02 模型配置坏 YAML 清空整配置**:mergeModelSection 解析失败原为 doc={} 后只写回 model 段,starrocks/auth/connections 全丢。修:返回 Result fail-closed(解析失败/根节点非映射均拒绝保存并提示人工修复;含数组根节点判定);writeConfigAtomic 临时文件+rename 原子写+写前 .bak 备份
- **model:test 补权限校验**(与 model:save 同 config:save 权限)
- **P1-04a SDK 沙箱彻底隔离+清理**:HOME/XDG_CONFIG_HOME/XDG_DATA_HOME 全部指向临时沙箱(denylist 漏项时的最后防线,真实 ~/.dsh、~/.claude、凭据不可达);cwd/home 目录随用随删(finally rmSync,实测 /tmp 零残留)
- **P0-03 profile 拆分**:beidou → beidou-web(明确为产品对话页 profile);一次性 headless 验证的官方正确姿势写入 profiles/README.md(--profile headless --patch 叠加同一份边界 patch,不复制漂移);本机 ~/.dsh 同步重装
- 测试:desktop 28(+5:工厂真实姿势保序/实例缓存/空间切换/坏YAML拒绝×2);端到端:沙箱隔离下全链路正常(检索→查指标→证据→done)
