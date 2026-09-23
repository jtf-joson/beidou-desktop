# DSH Desktop development guide

This guide covers local development, validation, patch maintenance, and target-native packaging. For the runtime design, see [Architecture](architecture.md). For formal releases, see the [release runbook](release-runbook.md).

## Prerequisites

- Node.js 22 or later
- npm
- macOS on Apple Silicon or Intel, or Windows x64

DSH Desktop currently pins `@deepseek-ai/dsh@0.1.1-rc.2`. Windows packages bundle a target-native Node.js runtime for Harness, while macOS uses an Electron UtilityProcess. Both are independent of the Node.js version used to run development commands.

## Local setup

```bash
git clone https://github.com/dataelement/dsh-desktop.git
cd dsh-desktop
npm ci
npm run dev
```

`npm ci` runs the repository's `postinstall` hook. It reapplies the tracked `patch-package` patches, installs DSH brand assets into the pinned Harness frontend, and installs Electron.

Development builds use the branded application name `北斗work` and the separate user-data directory `dsh-desktop-dev`, so they do not reuse production data. Multiple development worktrees still share that development profile by default; avoid running them at the same time when testing profile, plugin, migration, or recovery changes.

## Validation

Run the core checks before submitting a change:

```bash
npm test
npm run typecheck
npm run build
```

Static checks are not a substitute for runtime verification. Changes that affect startup, profiles, plugins, native dialogs, updates, mobile access, or packaging should also be exercised through the corresponding real application flow.

### 北斗work 语义资产与智能分析

`beidou-workspace` 是分析资产的权威 Git 仓，桌面端不直接让模型猜表或写业务口径：

```text
beidou-workspace
  → assets:bundle (manifest + assets + graph + checksums)
  → Bundle 完整性/分析就绪度检查
  → 语义检索(指标、术语、数据集、维度)
  → 指标口径编译 / 受控明细查询
  → 知识与 Playbook 关联
  → 结果、血缘、语义版本 EvidencePack
```

从资产仓重新编译默认种子 Bundle：

```bash
npm run assets:bundle -- --repo=../beidou-workspace \
  --out=build/beidou-workspace-seed/asset-bundle
npm run assets:bundle -- --out=build/beidou-workspace-seed/asset-bundle --check
```

`npm run build` 会自动执行资产引用检查、Bundle 编译和 Host 构建。运行时优先使用 `asset_bundle`；checksum、清单计数或语义图校验失败时才回退到 `asset_repo`，并在资产健康度中报告来源和版本。

普通指标必须具备平台回指、数据集、物理表和可编译口径。环比/同比等派生指标可以继承数据集和时间上下文，但不能复用基础指标公式；指标平台查询未配置时必须拒答，避免把销售额误报成环比/同比。

BS 服务域的元数据连接可以配置 `anymetrics.host`、`semantic_host`、`tenant_id` 和 `auth_type`；鉴权值只通过 `auth_value_env` 指向环境变量注入，例如 `BEIDOU_ANYMETRICS_AUTH_VALUE`，禁止把真实 `auth-value` 写入 YAML、Bundle、日志或提交记录。当前已验证/支持的元数据接口包括 `metrics/list`、`treeList`、`batchDetail`、`dimensionAll` 和血缘查询；指标数值查询仍需单独的取数协议。

开发环境启用 BS 在线取数时，只在当前 shell 注入鉴权值，不写入配置文件或资产 Bundle：

```bash
export BEIDOU_ANYMETRICS_AUTH_VALUE='<通过安全渠道取得的 UID auth-value>'
BEIDOU_ASSET_REPO=../beidou-workspace npm run dev

新工作区配置默认启用 `git pull --ff-only`，启动时会同步资产仓；网络、权限或本地未提交变更导致同步失败时，自动降级使用当前本地资产并记录告警。
```

启动后可通过资产概览 API 的 `counts.metricOnline` 判断在线取数是否接通。未接通时，普通指标仍可按资产口径走受控下钻；平台派生指标会明确拒答，不会用基础指标公式冒充环比或同比。

相关验证：

```bash
BEIDOU_ASSET_REPO=../beidou-workspace \
  npm --prefix packages/beidou-dsh-host run build
BEIDOU_ASSET_REPO=../beidou-workspace \
  ./node_modules/.bin/vitest run --config packages/beidou-dsh-host/vitest.config.ts \
  packages/beidou-dsh-host/src/eval-golden.test.ts
```

To exercise the Cloudflare-to-Pinggy fallback without disrupting the machine's network, start the development app with Cloudflare failure simulation enabled:

```bash
DSH_TUNNEL_FORCE_PINGGY=1 npm run dev
```

Then enable the temporary public tunnel from the phone connection screen. The tunnel status should report `pinggy`, and the generated URL should use a Pinggy hostname. This variable affects only the process started from that command; omit it on the next launch to restore the normal Cloudflare-first behavior.

Automatic fallback still happens only when Cloudflare fails to start. If a Cloudflare pairing link is already showing but the phone cannot open it, use **扫码打不开？换一条线路** / **Can't open? Try another link** on the pairing page to switch to Pinggy.

## Project map

```text
src/main/                 Electron main process and application orchestration
src/main/runtime/         Harness process lifecycle and diagnostics
src/main/state/           Profile consistency, repair, recovery, and Safe Mode
src/main/mobile/          Paired phone bridge and optional Cloudflare tunnel
src/main/update/          Installed-build update state and lifecycle
src/preload/              Narrow renderer-to-main IPC and desktop UI seams
src/shared/               Shared contracts and desktop menu definitions
packages/                 Bundled desktop support packages
patches/                  Reproducible patches for the pinned Harness packages
build/                    Packaged HTML, icons, loaders, and Harness entry files
scripts/                  Build, signing, metadata, and target verification tools
test/                     Unit and source-contract regression coverage
.github/workflows/        Native CI, signing, release, and publication workflows
```

## Maintaining upstream patches

The desktop product intentionally reuses the upstream Harness UI. Desktop-specific provider onboarding, preset transfer, model selection, workspace, branding, and layout changes are captured under `patches/` rather than stored as untracked edits in `node_modules`.

When upgrading Harness:

1. Install the intended upstream version.
2. Verify the current Settings, Credentials, Provider Directory, workspace, and preset contracts.
3. Reapply or rewrite each desktop customization.
4. Regenerate the relevant `patch-package` patches.
5. Run the full automated suite.
6. Start the real app and exercise every affected user flow.

## Packaging

Harness includes architecture-specific native dependencies. Build each installer on the operating system and architecture where it will run.

```bash
# macOS Apple Silicon, on an Apple Silicon Mac or runner
npm run package:mac:arm64

# macOS Intel, on an Intel Mac or runner
npm run package:mac:x64

# Windows x64 NSIS installer, on a Windows x64 machine or runner
npm run package:win
```

Do not invoke `electron-builder --win` from macOS or Linux for a distributable Windows package. The target verification scripts intentionally reject host/target mismatches.

For local unsigned development packages, use the corresponding `package:dev:*` command. Before handing off a Windows installer, verify that `resources/app/node_modules/node/bin/node.exe` exists in `win-unpacked` and require the packaged Windows Harness smoke test to pass.

Formal release artifacts are built, signed, and published by the tag workflow. A local build or pull-request check is not formal release evidence.

## Contribution hygiene

- Never include real API keys in issues, logs, screenshots, fixtures, or test data.
- Preserve unrelated worktree changes.
- Keep temporary research, local reports, and internal working documents under the ignored `doc/` directory.
- Update all localized README files when changing user-visible facts.
