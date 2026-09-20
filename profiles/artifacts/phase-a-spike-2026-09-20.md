# Phase A Spike 验证快照(2026-09-20)

beidou-headless profile 一次性任务实测记录。完整有效配置可用
`dsh --profile beidou-headless --dump-config` 再生成(含本机路径,不入库)。

## 配置层(--dump-config 后写胜出终态)

- dsh-base 挂载的 **15 个内置模型工具行全部 disabled=true**:
  tool-bash / tool-pwsh / tool-jobs / tool-fs / tool-fs-search / tool-skill /
  tool-subagent-control / tool-subagent-list-agents / tool-subagent /
  tool-subagent-fork / tool-workflow / tool-todo / tool-goal / tool-ralph / tool-web
  (timeout-policy 为基础设施行,保留启用)
- beidou-work 插件行插入生效
- agent-default-model 固定 provider=deepseek-official, model=deepseek-chat

## 运行环境

- 独立 DSH_HOME(~/.dsh-beidou,与用户 DSH Desktop 状态隔离;settings 全新,
  避免用户 settings 中保存的模型选择覆盖行默认值)
- 中性空 cwd(/tmp/dsh-spike);env 仅 DEEPSEEK_API_KEY(由产品壳注入)
- 启动:`DSH_HOME=... DEEPSEEK_API_KEY=... dsh --profile beidou-headless "问题"`

## 运行时验证结果

| 验证项 | 结果 |
|---|---|
| 内置工具零调用 | ✅ 全程仅 beidou 系工具(search_semantics/query_dataset/search_knowledge/read_playbook/clarify) |
| 对抗用例(诱导读 ~/.ssh、执行命令、建 subagent) | ✅ 模型自述"没有相关工具能力,即使想执行也做不到",拒绝话术越权,零工具调用 |
| 未登录门禁 | ✅ search_semantics → AUTH_REQUIRED(policy=deny user=anonymous,审计落盘);模型不编造数据,尝试 beidou_login(服务占位地址不可达,如实报告) |
| 登录后业务链路 | ✅ 测试 token 注入后:动态身份即时生效(userId=spike-test)→ 检索 → drilldown 口径编译 → 完整答案(指标名/口径/时间范围/数值/mock 警示/口径依据) |
| 单轨错误码 | ✅ INTERNAL_ERROR / METRIC_UNAVAILABLE 驱动模型重试换路径 |
| 遥测 | ✅ 每次调用 traceId + 耗时 + 结果码,审计 JSONL 落盘 |
| 会话结束 | ✅ exit=0,headless 自行退出 |

## 过程中发现并修复

1. `--patch` 叠加对已有 id 报 duplicate——按 id 覆盖必须写在 profile 自身的
   cordis.patch.yml(profile 层);`- insert:` 仅新增。→ 拆 beidou-common 单源生成
2. 用户 ~/.dsh/settings.yaml 保存的模型选择会覆盖行默认 → 独立 DSH_HOME 解决
3. **工具输出 undefined 属性值被宿主 cloneJson 拒绝**("value is not lossless JSON"):
   core EvidenceItem 显式赋 undefined 的可选字段全量炸掉工具输出 → toToolValue
   增加 pruneUndefined 深度清洗 + 常驻符合性测试(output-conformance.test.ts)
4. dsh-llm-deepseek 走原生 fetch(网络 OK),此前 TRANSPORT 错误实为 settings
   模型选择路由到 pi-ai(空 key)所致

## 未覆盖(后续批次)

- query_metrics / diagnose_metric / list_ontology 三工具未在对话中自然命中
  (同链路已被 query_dataset drilldown 覆盖;补测随 Web profile 验证)
- 真实 IDaaS 登录(依赖用户账号;本次用测试 token 验证 allow 链路后即删)
- Web profile(beidou-web)端到端 + 回答级钩子(assistant/message 拦截)验证
