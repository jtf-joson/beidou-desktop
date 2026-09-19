import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    // @beidou/core 为 workspace TS 包:不外置,直接打进主包(运行时无 node_modules 解析)
    plugins: [externalizeDepsPlugin({ exclude: ["@beidou/core"] })],
    resolve: {
      alias: [
        { find: "@beidou/core/src", replacement: resolve(__dirname, "../../packages/beidou-core/src") },
        { find: /^@beidou\/core$/, replacement: resolve(__dirname, "../../packages/beidou-core/src/index.ts") },
      ],
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: [
        { find: "@beidou/core/src", replacement: resolve(__dirname, "../../packages/beidou-core/src") },
        { find: /^@beidou\/core$/, replacement: resolve(__dirname, "../../packages/beidou-core/src/index.ts") },
      ],
    },
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
