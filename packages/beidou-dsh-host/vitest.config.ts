import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// host 包测试入口:根 vitest 配置只收集 test/**(上游桌面壳测试),
// 本包用例在 src/ 下,需本地配置指定收集范围(npx vitest run 于本目录执行)。
export default defineConfig({
  resolve: {
    alias: {
      "@beidou/core": resolve(__dirname, "../beidou-core"),
      "@beidou/contracts": resolve(__dirname, "../domain-contracts"),
      "@beidou/ontology-schema": resolve(__dirname, "../ontology-schema"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
