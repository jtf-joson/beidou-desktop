# 北斗work PoC 四壳对比报告(Phase 5)

> 日期:2026-09-20 | 基线 commit: 320710c | 目的:回答 F-10(最终壳决策)

## 1. 四壳概览

| | dsh Web | dsh-desktop | 北斗work Electron | 独立 Web |
|---|---|---|---|---|
| 本质 | dsh 内置 Web UI(本地 3080) | dsh Web 的 Electron 包装(7.5k star) | 自研 Electron + Agent SDK | 假设:Vue/React SPA + 后端 |
| 插件 | ✅ Cordis(我们已验证) | 同 dsh Web | ❌ 自有 MCP 工具 | 自建 |
| Agent 运行时 | dsh 自带 | dsh 自带 | Claude Agent SDK + DeepSeek | 自建/接入 |
| UI 自由度 | 低(受 dsh UI 框架约束) | 低(23 个 patch-package 补丁) | **高**(完全自控) | **高** |
| 通信 | token 门控 127.0.0.1 | 同 + Electron IPC | Electron IPC | HTTP/WebSocket |

## 2. 九维度评估

### 2.1 UI 可扩展性

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐⭐ | Cordis 插件可注册工具和 systemPrompt,但**无法自定义 UI 布局/面板/主题**;client-ui 是 40 个私有包,无开放 API |
| dsh-desktop | ⭐ | 对 UI 的定制全部通过 **23 个 patch-package 补丁**(钉死 0.1.5-rc.2),每次上游升级都要重打;不是插件能力,是 fork |
| **北斗work Electron** | ⭐⭐⭐⭐⭐ | 完全自控;已有 dsh 风格双主题 UI(图标栏+会话+证据面板)、语义/技能/插件/审计六页;**唯一的代价是所有 UI 都要自己写** |
| 独立 Web | ⭐⭐⭐⭐ | 自由度高,但需要自建整个前后端框架 |

### 2.2 工具轨迹(Tool Trajectory)

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐⭐⭐⭐ | **内置 Trajectory 视图**(dsh-client-ui-trajectory),自动展示每次工具调用的入参/出参/耗时;这是 dsh 最大的加分项 |
| dsh-desktop | ⭐⭐⭐⭐ | 同 dsh Web |
| **北斗work Electron** | ⭐⭐⭐ | 已有工具 chip(名称+状态)和 EvidencePack 面板(口径/SQL/血缘);缺少时间线视图和中间步骤展开 |
| 独立 Web | ⭐⭐ | 需要自建 |

### 2.3 Session 管理

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐⭐⭐⭐ | 完整的 Session 生命周期:创建/恢复/fork/持久化/标题自动摘要(SQLite/JSONL 双格式);**成熟度最高** |
| dsh-desktop | ⭐⭐⭐⭐ | 同 dsh Web + 升级时保留 profiles/sessions |
| **北斗work Electron** | ⭐⭐ | 有 localStorage 多会话(本轮修复了持久化),但无 fork/resume/跨重启恢复 |
| 独立 Web | ⭐⭐ | 需要自建(服务端存储) |

### 2.4 持久化

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐⭐⭐⭐ | JSONL 追加式会话日志 + SQLite 查询索引 + checkpoint/resume |
| dsh-desktop | ⭐⭐⭐⭐ | 同 dsh Web + 升级保留 |
| **北斗work Electron** | ⭐⭐ | 审计 JSONL + localStorage 会话;无 checkpoint/恢复 |
| 独立 Web | ⭐⭐ | 取决于后端设计 |

### 2.5 打包与分发

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐⭐ | `npx @deepseek-ai/dsh web` 即用;但需要 Node.js 环境,对非开发人员不友好 |
| dsh-desktop | ⭐⭐⭐⭐ | Electron + electron-builder,签名+公证 DMG/NSIS,自动更新(electron-updater);**企业分发能力最强** |
| **北斗work Electron** | ⭐⭐⭐⭐ | 已有 `npm run dist` → arm64 DMG(196MB);缺签名/公证/自动更新 |
| 独立 Web | ⭐⭐⭐ | Docker + Nginx 标准方案,无桌面体验 |

### 2.6 安全

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐⭐⭐ | 随机端口 + token 门控 + sandbox;但 Agent 的 bash/fs 工具默认全开 |
| dsh-desktop | ⭐⭐⭐⭐ | 同 + contextIsolation + nodeIntegration:false + Safe Mode + 沙箱策略 |
| **北斗work Electron** | ⭐⭐⭐⭐ | contextIsolation + nodeIntegration:false + **自建 SQL Guard(白名单+敏感列+LIMIT)+ 只读账号 + EvidencePack 脱敏 + 审计**;安全边界更可控 |
| 独立 Web | ⭐⭐⭐ | 需要自建(通常比桌面端弱) |

### 2.7 升级成本

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐⭐ | developer preview;**API 破坏性变更频繁**;我们已踩了 7 条 DSL 硬约束的坑 |
| dsh-desktop | ⭐ | **最差**:23 个 patch-package 补丁 + 精确版本锁 0.1.5-rc.2;每次上游升级 = 重打全部补丁 |
| **北斗work Electron** | ⭐⭐⭐⭐ | Agent SDK 版本锁定;core 零平台依赖(升级只改 adapter);**升级成本最低** |
| 独立 Web | ⭐⭐⭐⭐ | 自主可控,无外部升级压力 |

### 2.8 多用户适配

| | 评分 | 分析 |
|---|---|---|
| dsh Web | ⭐ | 单用户本地工具;无身份/权限/多租户概念 |
| dsh-desktop | ⭐ | 同上 |
| **北斗work Electron** | ⭐⭐⭐⭐ | **已有**:RBAC 四角色 + 空间隔离 + IDaaS 身份 + 成员管理 + 审计;多用户前置条件基本满足 |
| 独立 Web | ⭐⭐⭐⭐⭐ | 天然多用户(但需要自建全部) |

### 2.9 开发成本(已投入 vs 剩余)

| | 已投入 | 剩余到生产 |
|---|---|---|
| dsh Web 插件 | 3 天(Phase 1-4) | 协议单轨 + systemPrompt + 真实工具调用测试(约 1-2 周) |
| dsh-desktop | 0 | 需研究 patch 体系 + 定制 UI patch(约 2-4 周) |
| 北斗work Electron | 5 天(v0.1-v0.7) | Markdown 渲染 + 会话恢复 + 签名/自动更新(约 1 周) |
| 独立 Web | 0 | 全量自建(约 4-6 周) |

## 3. PoC 验证数据

| 验证项 | 结果 | 说明 |
|---|---|---|
| dsh 插件装载 | ✅ V1 PASS | 10 工具(8 业务+2 身份) |
| dsh DSL 兼容 | ✅ 7 条硬约束全摸清 | required:true / additionalProperties / object required / async apply / ESM / esbuild / error propagation |
| esbuild 打包 | ✅ 423KB 单文件 | 解决 dsh ESM 不认 TS 源码问题 |
| 北斗work 桌面 | ✅ DMG 构建通过 | v0.7.0 双主题 UI |
| 测试基线 | 192 core + 12 desktop + 2 contracts = 206 | 三轮外部 review 修复 |

## 4. F-10 决策建议

### 推荐:**北斗work Electron 为主壳,dsh 插件为能力分发通道**

| 维度 | 判断 |
|---|---|
| **UI/UX** | 北斗work 完胜——本体管理、语义配置、证据面板、多空间这些深度 UI 在 dsh Web 里无法实现 |
| **安全** | 北斗work 更可控——SQL Guard + RBAC + 空间隔离 + IDaaS 已落地;dsh 的 bash/fs 工具是安全负债 |
| **升级** | 北斗work 更稳——Agent SDK 独立于 dsh preview;dsh-desktop 的 23 补丁是不可持续的 |
| **多用户** | 北斗work 已有基础;dsh Web 根本没有多用户概念 |
| **工具轨迹** | dsh Web 胜——内置 Trajectory 是最好的调试体验;北斗work 可以借鉴实现 |
| **会话管理** | dsh Web 胜——checkpoint/resume/fork 成熟;北斗work 可以后补 |

### 具体策略

```
北斗work Electron = 主产品(企业桌面端,含本体管理/权限/审计)
dsh 插件 = 能力分发通道(核心工具包以 Cordis 插件形式发布,供 dsh 生态用户使用)
独立 Web = 暂不做(多用户需求由 Electron + GitLab 权限管理承接)
dsh-desktop = 不采用(patch 成本不可持续)
```

### 需要从 dsh 生态借鉴的能力(优先级排序)

1. **会话持久化/恢复**(checkpoint/resume) — 高
2. **工具时间线视图**(Trajectory) — 中
3. **会话标题自动摘要** — 低

## 5. 后续排期建议

| 优先级 | 任务 | 预估 |
|---|---|---|
| P0 | 北斗work 补会话持久化(JSONL + checkpoint) | 2 天 |
| P0 | 北斗work 补 Markdown 渲染(消息表格/代码高亮) | 1 天 |
| P1 | 北斗work 补工具时间线视图(参照 dsh Trajectory) | 2 天 |
| P1 | dsh 插件完成协议单轨(BeidouToolResult) | 3 天 |
| P1 | dsh 插件 systemPrompt 注入 | 1 天 |
| P2 | 北斗work 签名/公证/自动更新 | 1 天 |
| P2 | 指标平台在线主链路(F-5 联调) | 依赖用户 |
| P2 | 真实 StarRocks(V9) | 依赖用户 |

## 6. PoC 结论

```text
本地 Mock PoC:                    ✅ PASS
dsh 插件工具注册(10 个):          ✅ PASS
真实业务诊断任务(受控 Mock):       ✅ PASS(桌面端 mock 全链路)
真实指标平台联调:                  ⏸ 待用户提供服务地址
真实 StarRocks:                    ⏸ 待用户提供只读账号
多人试点:                          ❌ 需完成签名/公证/自动更新
```

**总评**:PoC 的核心价值已验证——同一套 beidou-core 能同时驱动自研桌面壳和 dsh 插件宿主,证明 core 抽象是正确的。壳的最终决策建议以北斗work Electron 为主,dsh 插件作为能力分发通道继续维护。
