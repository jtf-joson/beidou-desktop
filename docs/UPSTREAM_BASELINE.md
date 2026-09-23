# 上游基线(UPSTREAM BASELINE)

> 北斗work 二开基线。任何升级必须先更新本文件并通过回归。

## 基线快照(2026-09-21)

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/dataelement/dsh-desktop |
| 上游 Commit | `f4874631f783ca9871e1ed0c53ed0bf1ae793c7d` |
| 上游版本 | dsh-desktop 0.1.1 |
| Harness 版本 | @deepseek-ai/dsh 0.1.5-rc.2(patch-package 锁定) |
| Cordis | @deepseek-ai/cordis 4.0.2 |
| Node(开发) | ≥22.15(运行时侧打包自带,见 build/harness-node-entry.mjs) |
| Electron | 见 package.json devDependencies(electron-builder 打包) |
| 北斗包 | beidou-core 0.7.0 / domain-contracts / ontology-schema / beidou-dsh-host(file:packages/*) |

## 与上游的差异(北斗自有)

- `packages/beidou-core|domain-contracts|ontology-schema|beidou-dsh-host`:北斗业务包(从 legacy-selfbuilt-shell 仓迁入)
- `build/beidou.patch.yml`:北斗 patch 层(15 内置工具行禁用 + beidou-dsh-host 插入 + 模型固定 deepseek-official)
- `src/main/runtime/harness-runtime.ts`:新增 `dshBeidouPatchPath` option(非 Safe Mode 追加北斗 patch)
- `src/main/index.ts`:传入 beidou patch 路径
- `package.json`:name/productName 品牌化 + 北斗包依赖
- `scripts/build-beidou-host.mjs`:北斗 Host 插件 esbuild 打包

## 已知基线问题

- `test/ppt-validation.test.mjs` 在本环境 hook 超时(上游 PPT 打包套件,与北斗无关)

## 升级流程(摘自方案 V1.0 §17.3)

upstream-sync 分支 → 合并上游 → 重放 Patch → Profile Diff(dump-config)→
Tool Set 精确断言(==10)→ 全量测试 → 安装包冒烟 → 安全对抗 → PR。
