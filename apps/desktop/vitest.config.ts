import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@beidou\/core\/src\/(.+)$/, replacement: path.resolve(__dirname, "../../packages/beidou-core/src/$1") },
      { find: /^@beidou\/core$/, replacement: path.resolve(__dirname, "../../packages/beidou-core/src/index.ts") },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: { include: ["src/**", "tests/**"], thresholds: { lines: 50, functions: 40, statements: 50, branches: 30 } },
  },
});
