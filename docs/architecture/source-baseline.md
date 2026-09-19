# 代码与依赖基线(P0-1,进入开发前锁定)

```yaml
# 本文件由 scripts/update-baseline.sh 维护;变更须同步评审
harness_repository: https://github.com/deepseek-ai/deepseek-harness
harness_commit: 见 /tmp/dsh-probe(探测克隆;正式开发时锁定精确 commit)
dsh_npm_version: 0.1.5-rc.2   # dsh-desktop 同款锁定版本
beidou_core_repository: 本地 /Users/demo_user/databuddy/app(计划迁公司 GitLab,分仓 beidou-work/beidou-workspace)
beidou_core_commit: (本仓 packages/beidou-core,随仓库演进;发布时打 tag)
node_version: v22.22.0
package_manager: npm 10.9.4(插件包采用 pnpm workspace,见 V2 计划)
typescript_version: 5.6.0
electron_version: 33.2.0
```

## 仓库边界(已确认 F-7)
- **beidou-work**(代码仓):apps/desktop(现有 Electron 壳)+ packages/{beidou-core,domain-contracts,ontology-schema,dsh-plugin-beidou}
- **beidou-workspace**(资产仓):semantics/(ontology/bindings/glossary)+ knowledge/ + playbooks/ + scope/;按 subdomain owners 评审
- 当前状态(Phase 0 完成,2026-09-19):npm workspaces monorepo 已建——packages/beidou-core(183 测试,零 electron/react/node 依赖,仅 yaml)、packages/domain-contracts(协议层)、apps/desktop(壳,构建把 core 打包进产物);测试基线:core 183 + contracts 2 + desktop e2e 10(1 manual skip);package-lock.json 入库(精确锁定);资产样例 workspaces/service-domain-example(单 schema 双 subdomain,user-exp=draft;RELEASE.md 模板)
