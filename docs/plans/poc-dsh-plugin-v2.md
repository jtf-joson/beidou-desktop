# 北斗work dsh 插件 PoC 计划 V2(吸收评审 V1)

> V1 = ~/.claude/plans/poc-1-2-binary-magpie.md(已批准);评审 = docs/reviews/2026-09-19-dsh-poc-review-v1.md。
> 本版落实评审全部 P0、PoC 内完成 P1;回答评审第 7 节十问(见文末)。

## 修订要点(V1 → V2)

| 评审项 | 修订 |
|---|---|
| P0-1 基线 | 新增 docs/architecture/source-baseline.md(harness/core commit、版本);迁移时更新 |
| P0-2 工具数 | **10 个 = 业务工具 8(search_semantics/query_metrics/query_dataset/clarify/diagnose_metric/search_knowledge/read_playbook/list_ontology)+ 身份工具 2(beidou_login/beidou_auth_status)**;metricOnline=false 时 query_metrics 仍注册、走口径编译降级(与桌面端一致),V3/V4 = 口径编译 + mock 连接器(诚实标注) |
| P0-3 仓库结构 | **pnpm workspace monorepo**:beidou-work/{apps/desktop, packages/beidou-core, packages/domain-contracts, packages/ontology-schema, packages/dsh-plugin-beidou};插件依赖 `@beidou/core: workspace:*`,禁止跨仓库相对 TS 源引用(那仅作为 F-9 的 1 小时可行性验证,不作为结构) |
| P0-4 可移植 | 仓库只提交 `cordis.example.yml`;`pnpm dsh:poc` 脚本动态解析绝对路径生成 `.tmp/cordis.local.yml`;验收=任意目录 clone 后 `pnpm install && pnpm dsh:poc` 可加载 |
| P0-5 顺序 | **Ontology 内核先行**(见下方 Phase 表);依赖本体的 V2/list_ontology 在内核之后 |
| P0-6 失败策略 | 采纳评审的 fail 边界表(全文引用见 §失败策略);禁止:权限异常默认放行、Binding 无效猜表、指标版本冲突自动选 |
| P0-7 owner | config `auth_mode: single-user-poc`;多用户前置条件清单入 SPEC(真实 open_id/隔离/Keychain/集中撤销) |
| P1-1 绑定拆分 | **semantics/ontology.yaml(概念)+ semantics/bindings/{datasets,tables,metrics,knowledge}.yaml(指针)**,双版本独立;改表名不动本体主版本 |
| P1-2 治理字段 | schema 预留 status/owners/tags/effectiveFrom/sensitivity 等(PoC 只存不强制) |
| P1-3 协议层 | 插件内 schemas.ts/errors.ts/policy.ts/telemetry.ts;统一 BeidouToolResult{ok,code,data?,warnings?,evidence?,traceId} + 12 个错误码 |
| P1-4 安全 | 字段白名单/行级权限/超时/参数化/Query ID 关联 → 真实数据前(Gate C)完成;Connection Router 冲突规则定版(优先级:ontology 精确表 > schema 前缀 > dataset 卡片 > default;未命中 default=拒绝;禁用户输入覆盖 profile) |
| P1-5 审计 | 统一事件 Schema(timestamp/traceId/sessionId/userId/tool/policyDecision/dataSources/durationMs/resultCode/errorCode);AuditSink 接口 + JsonlAuditSink(PoC)/RemoteAuditSink(预留) |
| P1-6 Skill | 结构化 YAML 定义(id/version/requiredTools/steps/evidencePolicy/sensitiveFields/crossDomainPolicy/outputSchema);**敏感字段在工具输出层脱敏**(不只靠模型);输出事实/推断/建议三段分离 |
| P1-7 验收 | V1–V9 → 可执行用例 + **Gate A(插件基础:V1/V2/V6/V8)/ Gate B(业务闭环:V3/V4/V5)/ Gate C(企业集成:V7/V9)**;补评审列出的 10 类测试(extends 环/relation 悬空/token 过期/注入绕过/敏感泄漏等) |

## 目标仓库结构(P0-3)

```
beidou-work/                      # GitLab 代码仓
├── apps/desktop/                 # 现有 Electron 壳(整体迁入)
├── packages/
│   ├── beidou-core/              # app/src/core 原样迁出(零依赖红线不变)
│   ├── domain-contracts/         # BeidouToolResult/错误码/EvidenceRef/审计事件 Schema
│   ├── ontology-schema/          # parseOntology/validateOntology/bindings 装载
│   └── dsh-plugin-beidou/        # Cordis 插件(index/context/adapter/tools/schemas/errors/policy/telemetry/idaas-tool)
├── workspaces/service-domain-example/   # 资产样例(真实资产在 beidou-workspace 仓)
├── scripts/{migrate-entities,ontology-lint,generate-cordis-config}.ts
├── docs/{adr,plans,reviews,acceptance,architecture}
└── pnpm-workspace.yaml
```

## 资产仓结构(P1-1)

```
beidou-workspace/
└── semantics/
    ├── ontology.yaml             # 概念层:domain/subdomain/topic/class/property/relation/action(治理字段齐)
    ├── bindings/
    │   ├── datasets.yaml         # dataset→表指针+connection profile
    │   ├── tables.yaml           # 表→字段白名单/敏感标记(可选覆盖导入)
    │   ├── metrics.yaml          # class→metricName 引用(→指标平台)
    │   └── knowledge.yaml        # class→知识文件引用
    └── glossary.yaml
```

## 失败策略(P0-6,定版)

| 场景 | 策略 |
|---|---|
| 本体搜索/预览 | fail-open + 告警 |
| 本体发布(CI lint) | **fail-closed** |
| 指标/表绑定缺失 | **拒绝**对应查询(BINDING_NOT_FOUND) |
| 权限/白名单读取失败 | **fail-closed** |
| 知识文件缺失 | 降级 + 标注证据不足 |
| 审计写入失败 | PoC 告警;Gate C 起高风险调用阻断 |

## Phase 计划(P0-5 顺序)

- **Phase 0 基线与决策**:source-baseline.md、pnpm workspace 搭建、beidou-core 迁出(测试全绿)、ADR-001(插件宿主决策)。
- **Phase 1 空壳验证(F-9+V1)**:dsh-plugin-beidou 骨架 + dummy 工具 + generate-cordis-config + `pnpm dsh:poc`;V1 自动化。
- **Phase 2 Ontology V1**:ontology-schema 包(schema+parser+validator+bindings 装载+迁移脚本+migrate-entities);search_semantics 命中扩容 + list_ontology;**V2**。
- **Phase 3 Mock 业务闭环**:context/adapter/tools 10 工具接线;诊断/知识/Playbook/审计;结构化 Skill ×2;**V3–V6(Gate A+B)**。
- **Phase 4 身份与真实数据**:idaas-tool(F-1 实测先行)+ Token 生命周期;connection-router + 字段白名单;**V7/V9(Gate C,均非阻塞,V9 依赖账号)**。
- **Phase 5 结论**:四壳对比报告(Harness Web / dsh-desktop / 北斗 Electron / 独立 Web,按评审 9 维度),回答 F-10。

## 评审十问的回答(进入编码前)

1. **core 在哪**:/Users/demo_user/databuddy/app 本地 git(main,基线 commit ce6ea04);Phase 0 迁入 pnpm workspace 的 packages/beidou-core。
2. **拆 workspace 包**:是(P0-3,Phase 0 完成)。
3. **权威源**:当前本地;目标公司 GitLab(代码仓 beidou-work + 资产仓 beidou-workspace,已确认分仓)。
4. **资产分仓**:是(F-7 已确认)。
5. **首个子域**:两域 schema 都建;**内容先门店经营跑通全链路,用户体验第二步补齐**(避免双线阻塞;与「脚本起草+业务定稿」并行)。
6. **V3/V4 数据**:口径编译 SQL + mock 连接器(诚实标注);在线指标接口关闭(F-5 联调后开)。
7. **V9 强制否**:**否**——依赖真实只读账号(待提供),Gate C 达成即验收;无账号则记录阻塞项。
8. **owner 单用户 PoC**:是,auth_mode: single-user-poc,多用户前置条件已入 SPEC S9。
9. **真实 StarRocks 账号**:**暂无**——需要用户提供只读账号(含门店/体验域表的权限);V9 阻塞于此。
10. **成功标准**:**完成一个真实诊断任务**(门店经营周诊断:本体导航→指标→口径下钻→归因→知识库→报告),而非"插件可运行";数据可为 mock 但链路全真(与 SPEC Q5.2.0 一致)。

## 验收用例模板(P1-7)

每个 V 项落为 `docs/acceptance/V*.yaml`:`{id, precondition, input, expectedToolCalls, expectedOutput, expectedEvidence, expectedAudit, expectedError?, automation}`;自动化跑在 vitest(工具层)+ dsh web 冒烟脚本(壳层)。

---

## V2.1 基线定稿(用户终审七点,2026-09-19;此后不再扩方案,直接开发)

1. **一套 schema、两个 subdomain**:ontology schema 只有一套;store-ops(内容先行)、user-exp(**status: draft**)同文件声明,不做两套 schema。
2. **Phase 3 = 8 个业务工具**(search_semantics/query_metrics/query_dataset/clarify/diagnose_metric/search_knowledge/read_playbook/list_ontology);**Phase 4 再接 2 个身份工具**(beidou_login/beidou_auth_status)。
3. **Gate 重定义(解决 V8 时序冲突)**:
   - **Gate A 插件基础**:V1 装载 / V2 语义检索 / V6 审计
   - **Gate B 业务闭环**:V3 指标 / V4 下钻 / V5 诊断
   - **Gate S 安全护栏**:V8 白名单拒绝 + 安全测试组(注入绕过/敏感泄漏/extends 环/token 过期)——在字段白名单与脱敏管线(Phase 3 末/4)就绪后验收
   - **Gate C 企业集成**:V7 IDaaS / V9 真实数据
4. **成功标准定版**:**真实业务问题 + 全真链路 + 受控 Mock 数据**(mock=受控语义本体+数据值,能力全真,SPEC Q5.2.0 不变)。
5. **V9 缺失时**:PoC 结论只能标记「**真实数据集成未完成**」,不得视为通过或跳过。
6. **精确依赖锁定**:根 package-lock.json 入库;harness/@deepseek-ai 包精确版本锁(=0.1.5-rc.2,不用 ^);**资产版本发布清单**:每次资产仓发布须含 RELEASE.md(ontology/bindings 版本号、变更摘要、validator 结果、影响面),见 workspaces/service-domain-example/RELEASE.md 模板。
7. **脱敏时点**:敏感字段脱敏发生在**日志、审计与模型输出之前**(工具输出管线统一 redact,三者共用同一脱敏点;不以"要求模型不展示"作为手段)。

## 旧代码符合性审计结论(2026-09-19)

| 存留 | 代码 | 处置 |
|---|---|---|
| ✅ 保留 | core 全部(guard/compiler/diagnosis/services/auth/rbac/scope/audit/evidence/7 工具) | 迁 packages/beidou-core |
| ✅ 保留 | 桌面壳(apps/desktop)、mock 连接器、演示语义包 | 受控 Mock 的一部分 |
| ❌ 移除 | entities.yaml 模型(EntityDef/BusinessModelDef/parseEntities/modelsForMetric)及"一版回退" | **Phase 2 由 ontology-schema 一次性取代**(迁移脚本转换旧文件;不再保留运行时回退),符合"不符合就去掉" |
| ⚠️ 重接 | 语义页"实体与业务模型"Tab、entities IPC | Phase 2 改指 ontology.yaml |
