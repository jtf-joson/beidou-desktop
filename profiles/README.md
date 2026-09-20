# 北斗work DSH Profiles

Phase A 起的 DSH 侧 profile 约定。**工具边界 patch 的唯一权威源是
[beidou-web/cordis.patch.yml](beidou-web/cordis.patch.yml)**(禁 14 个内置工具行 + 插入
beidou-work 插件);其他形态一律从它派生,不复制修改,防漂移(审核六轮 P0-03)。

## beidou-web(产品对话页)

组成:`dsh-base + dsh-web-app`,叠加边界 patch。

```bash
# 本机安装(sed 解析 __BEIDOU_PLUGIN_ENTRY__ 占位符为本机 dist 绝对路径)
rm -rf ~/.dsh/profiles/beidou-web && mkdir -p ~/.dsh/profiles/beidou-web
cp profiles/beidou-web/package.json ~/.dsh/profiles/beidou-web/
sed "s|__BEIDOU_PLUGIN_ENTRY__|$(pwd)/packages/dsh-plugin-beidou/dist/index.js|" \
  profiles/beidou-web/cordis.patch.yml > ~/.dsh/profiles/beidou-web/cordis.patch.yml

dsh --profile beidou-web   # 起服务式 Web 会话
```

## 一次性 headless 验证(Phase A spike 正确姿势)

**不要** `dsh --profile beidou-web "问题"`——web profile 不接受一次性任务位置参数
(审核六轮 P0-03)。官方一次性任务由 `dsh-headless` bundle 提供,用 `--patch`
把同一份边界 patch 叠加到官方 headless 模板上:

```bash
# 若 headless profile 尚未实例化,先从官方模板创建(一次性):
dsh --profile headless --from-default-profile headless

# 叠加北斗边界 patch 跑一轮(--json 输出事件流):
dsh --profile headless \
  --patch ~/.dsh/profiles/beidou-web/cordis.patch.yml \
  --json \
  "高速智驾天数本月是多少"
```

## 升级纪律

- 行 id 对照 `dsh-base/cordis.patch.yml`(当前锁定 0.1.5-rc.2);DSH 升级后必须
  复核 disable 清单 + 用 `--dump-config` 比对有效配置快照(审核六轮 P0-04 配置层门禁)。
- 插件 dist 由 esbuild 产出,`@deepseek-ai/*` 为 external(宿主提供)——改插件源码后
  先 `npm run plugin:build` 再起 profile。
