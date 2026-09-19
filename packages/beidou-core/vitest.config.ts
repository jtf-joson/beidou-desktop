import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@beidou\/ontology-schema\/src\/(.+)$/, replacement: path.resolve(__dirname, "../ontology-schema/src/$1") },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: { include: ["src/**"], thresholds: { lines: 85, functions: 80, statements: 85, branches: 75 } },
  },
});
