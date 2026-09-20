import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@beidou-core\/(.+)$/, replacement: path.resolve(__dirname, "../beidou-core/src/$1") },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
