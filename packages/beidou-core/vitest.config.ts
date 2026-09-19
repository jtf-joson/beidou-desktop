import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: { include: ["src/**"], thresholds: { lines: 85, functions: 80, statements: 85, branches: 75 } },
  },
});
