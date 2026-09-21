# ARCHITECTURE v2:北斗work 终态架构

> 取代 v1(2026-09-17,基于 Claude Agent SDK 的四层设计)。
> v2 反映 2026-09-21 定版:**DeepSeek Harness(DSH)为唯一 Agent Runtime,北斗work
> 是垂域 agent 产品壳——通用对话能力全套复用 DSH,自研集中在业务定制层**。
> 演进史见 CHANGELOG 0.16.x–0.17.x 与 docs/reviews/。

## 1. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ 北斗work Electron 产品壳                                    │
│   左侧定制分组导航(分析/语义治理/智能资产/系统)+ 顶栏       │
│   ├─ 智能分析助手 ──── DSH Web 完整界面(WebContentsView)   │
│   │                    (DSH 自带会话侧栏/对话/右栏/渲染)    │
│   ├─ 分析历史(旧会话只读归档)                             │
│   ├─ 语义资产 / 知识与 SOP / 数据连接 / 审计 / 设置         │
│   └─ DSH 进程管理器(启动/健康/重启/退出)                  │
├────────────────────────────────────────────────────────────┤
│ DeepSeek Harness Runtime(独立子进程,Node ≥22.15)         │
│   beidou-web profile = dsh-base + dsh-web-app + beidou patch │
│   DeepSeek 模型(deepseek-official/deepseek-chat)           │
│   Agent Loop / Session 持久化 / 工具轨迹 / Web 服务         │
│   模型可见工具 = 仅北斗 10 工具(边界见 §3)                │
├────────────────────────────────────────────────────────────┤
│ beidou-work 插件(Cordis,协议转换层——业务逻辑零实现)      │
│   10 工具注册(8 业务 + 2 身份)· BeidouToolResult 单轨     │
│   systemPrompt 注入 · policy 白名单 · telemetry(AuditV2)   │
├────────────────────────────────────────────────────────────┤
│ beidou-core(唯一业务内核,零 Electron/DSH 依赖)           │
│   本体/语义编译器/口径 DSL→SQL/诊断归因/知识库/Playbook     │
│   SQL Guard/EvidencePack/脱敏/审计/身份/RBAC/会话回放      │
└────────────────────────────────────────────────────────────┘
        │                │                │
   指标平台 API      StarRocks(mock/真实)  知识/资产仓(文件)
```

## 2. 各层职责与代码位置

| 层 | 职责 | 不做什么 | 代码 |
|---|---|---|---|
| Electron 壳 | 定制导航/管理页/进程管理/身份入口/窗口安全 | 不做对话渲染、不跑 Agent 循环 | `apps/desktop/src/main` |
| DSH Runtime | 对话全链路:模型调用/会话/轨迹/渲染/Web 服务 | 不知道北斗业务 | `profiles/`(profile 组成) |
| beidou-work 插件 | 协议转换:工具注册/prompt/policy/遥测 | 不实现指标规则、SQL 编译、权限逻辑、诊断、路由、降级 | `packages/dsh-plugin-beidou` |
| beidou-core | 全部业务逻辑 | 不依赖 DSH/Electron 类型 | `packages/beidou-core` |

## 3. DSH 运行时设计

### 3.1 Profiles(单一权威源)

```
profiles/beidou-common/cordis.patch.yml   ← 唯一权威 patch
  禁用 dsh-base 全部 15 个内置模型工具行(id 覆盖语法)
  插入 beidou-work 插件(__BEIDOU_PLUGIN_ENTRY__ 占位符)
  模型固定 deepseek-official/deepseek-chat(决策 3)
profiles/beidou-web/    = dsh-base + dsh-web-app   (产品对话页)
profiles/beidou-sdk/    = dsh-base + dsh-sdk-app   (自动化测试/黄金问题)
scripts/sync-beidou-profiles.mjs  物化安装(防漂移,不手抄)
scripts/check-dsh-tool-boundary.mjs CI 断言(dump-config 15 行全禁)
```

### 3.2 工具边界(四层防线)

1. **Profile 组成层**:15 个内置工具行禁用(配置层,CI 断言)
2. **注册层**:模型 schema 里只存在北斗 10 工具
3. **执行层**:插件 policy 正向白名单(越界=TOOL_NOT_ALLOWED,fail-closed)
4. **OS 边界层**:独立 DSH_HOME(userData/dsh-homes/<空间哈希>)、空 cwd、
   env allowlist(BEIDOU_WORKSPACE/BEIDOU_OPEN_ID/DEEPSEEK_API_KEY 等 7 项)

### 3.3 生命周期(dsh-runtime.ts)

状态机 idle→starting→ready→crashed/stopping;启动失败 SIGKILL 清理;
ready 后 exit 监听(拒绝假健康)→ 通知渲染层自动重连;stop=SIGTERM→5s→SIGKILL;
空间切换/模型 key 变更 → 停止+销毁 View+dsh:restart 通知重建。
回环 127.0.0.1+动态端口+token URL;WebContentsView 独立安全边界
(sandbox/精确 origin 导航/window-open 拒绝/权限默认拒)。

## 4. 协议与治理

- **BeidouToolResult 单轨**:`{ok, code, message, data, warnings, evidence, traceId}`,
  13 个机器可判别错误码(domain-contracts);工具输出 pruneUndefined(DSH 宿主要求无损 JSON)
- **事前规范**:systemPrompt 注入路由协议与资产清单(order=TOOLS_SDK−500)+
  工具 schema + policy 白名单 + 未登录拒绝业务工具(AUTH_REQUIRED)
- **事后审计**:telemetry 每次调用落 AuditEventV2(traceId/时长/结果码/策略裁决/userId)
- **身份**:BEIDOU_OPEN_ID 与壳同源(动态身份,登录后免重启生效;cachedToken fail-closed)

## 5. UI 形态决策史(三步)

| 版本 | 形态 | 结论 |
|---|---|---|
| 0.17.0–0.17.1 | 嵌入 DSH Web | 双导航(壳会话列表+DSH 侧栏) |
| 0.17.2 | 自研聊天窗口(SDK JSON-RPC) | 展示效果达不到 DSH Desktop,重造轮子 |
| **0.17.3(终态)** | **壳仅定制导航 + DSH 全套复用** | 职责分明:壳 rail=菜单,DSH 侧栏=会话列表 |

**定制可视化路线(未来)**:DSH UI 组件族(dsh-client-ui-*)是 Cordis client 插件,
经 beidou-dsh-client 做北斗品牌主题、业务结果专属渲染卡(Conversation Node)、
Evidence Panel——在 DSH 框架内扩展,不 fork 其代码。

## 6. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | DSH 唯一 Runtime(删 Claude Agent SDK) | 消双运行时漂移与 214MB 平台二进制;对话能力原生 |
| D2 | 壳仅定制导航,DSH 界面全套复用 | 垂域 agent:通用能力零重造,投入集中在业务定制 |
| D3 | 第一阶段仅 DeepSeek | beidou profile 固定 provider/model;壳只管 key 注入 |
| D4 | 旧会话只读保留 | JSONL 归档页(分析历史),不做迁移 |
| D5 | 门禁先软后硬(分风险层) | 安全/权限类第一天硬阻断;质量类(Evidence)先标记后阻断 |
| D6 | Node ≥22.15 依赖 | DSH 需 node:zlib zstd;壳探测系统 node(打包链待内置) |

## 7. 当前边界与路线图

**已闭环**:dev 态全链路(壳→DSH→插件→core→mock 数据);工具边界四层;
身份/审计;崩溃恢复;对抗用例零逃逸(Phase A 实证)。

**待办(按优先级)**:
1. **打包链(P0-03)**:extraResources 物化(DSH/插件/profiles)+ Node sidecar +
   干净机器验证(当前依赖开发机 node 与仓库 node_modules)
2. 验收补全:10 工具符合性、真实 IDaaS、回答级钩子(assistant/message)、黄金问题回归集
3. 定制可视化:beidou-dsh-client(主题/业务结果卡/Evidence 面板)
4. 企业数据主链路:指标平台在线主路径、Connection Router 接执行层、
   字段/行权限、PII、SQL AST/EXPLAIN、真实 StarRocks
5. 治理:插件初始化生命周期、DSH sessionId 贯穿审计、inputSummary PII、
   DSH permission preset 收紧、语义版本/评测中心
