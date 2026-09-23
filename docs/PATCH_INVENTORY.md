# Patch 清单(PATCH INVENTORY)

> 目标:硬 Patch 数量持续下降。北斗优先级:新增包 > Profile/Patch 层 > 插件 > patch-package > 改上游核心。

## 上游 patch-package 补丁(patches/,共 25 个)

上游 dsh-desktop 自身维护(@deepseek-ai/dsh* 0.1.5-rc.2 系列等)。
北斗不修改这些补丁;升级时随上游一并更新,冲突时以北斗 beidou.patch.yml 与插件优先。

## 北斗 patch 层(build/*.patch.yml)

| 文件 | 来源 | 内容 | 删除条件 |
|---|---|---|---|
| beidou.patch.yml | 北斗新增 | 禁 15 内置工具行 + 插 beidou-dsh-host + 模型固定 deepseek-official | 无(D3 决策生效期内长期保留;行 id 随 dsh-base 升级复核) |
| dsh-desktop.patch.yml | 上游 | 桌面插件组装 | 上游维护 |
| dsh-desktop-safe.patch.yml | 上游 | Safe Mode 组成 | 上游维护 |
| dsh-desktop-market.patch.yml | 上游 | 插件市场入口(方案 §14:普通用户应隐藏,待北斗 Client Plugin 处理) | 上游维护 |

## 北斗对上游源码的修改(硬改,需逐条复核)

| 文件 | 改动 | 原因 | 替代方案(争取回退) |
|---|---|---|---|
| src/main/runtime/harness-runtime.ts | +dshBeidouPatchPath option,patchPaths 数组追加 | 北斗 patch 层注入点 | 推动上游支持多 patch 配置项后回退 |
| src/main/index.ts | 传 beidou patch 路径 | 同上 | 同上 |
| package.json | name/productName/北斗依赖 | 品牌 | 保留 |
| tsconfig.json | exclude 北斗包(独立编译) | 根 typecheck 不识别 TS 源码包 | 北斗包编译产物化后移除 |

## 已知问题(Phase 0)

- **generations migration 对 beidou-dsh-host 报 "no readable bundle patch"**:插件功能不受影响
  (每次启动从共享树正常加载,0 plugin failures;警告源于桌面把 profile dependencies 里的插件
  升格为 generation 时的 bundle 校验)。Phase 1 计划:查 pnpm file: staging 对 package.json
  `dsh.bundle.patch` 字段/文件的传递,或小改上游 KEEP_IN_SHARED_TREE 白名单。
- beidou-dsh-host 进 profile 依赖需执行一次
  `DSH_HOME=<home> node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web install`
  (首启自动化列入 Phase 1)。
