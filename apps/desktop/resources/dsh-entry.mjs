/**
 * DSH 启动包装器(经 ELECTRON_RUN_AS_NODE 运行)。
 * 背景:dsh bin.js 以 `if (import.meta.main)` 自启——该字段是 Node 22 特性,
 * Electron 33 内置 node 20.18 无此字段 → 静默跳过主流程、退出码 0。
 * 本包装器显式调用 bin.js 导出的 runCli()(其内部读 process.argv,参数原样透传)。
 */
const bin = process.env.DSH_BIN_JS;
if (!bin) {
  console.error("dsh-entry: missing DSH_BIN_JS env");
  process.exit(2);
}
const { runCli } = await import(bin);
await runCli();
