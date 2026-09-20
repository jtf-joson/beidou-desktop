import { describe, expect, it } from "vitest";
import { createCachedSessionStoreFactory } from "./session-store-factory";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

/**
 * 审核六轮 P0-01 回归:串行队列必须在"主进程实际调用方式"(每次事件都调工厂)
 * 下生效——此前工厂每次 new 新实例,各事件拿空队列,乱序复现。
 */
describe("createCachedSessionStoreFactory(P0-01 缓存工厂)", () => {
  it("经工厂 30 次并发 append(每次都调 factory)落盘顺序 = 提交顺序", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "daw-factory-a-"));
    try {
      const factory = createCachedSessionStoreFactory(() => dirA);
      const jobs: Array<Promise<void>> = [];
      for (let i = 0; i < 30; i++) {
        // 关键:每次 append 前重新调用 factory()——模拟主进程 persist 路径
        jobs.push(factory().append({ ts: new Date(Date.now() + i).toISOString(), sessionId: "s1", type: "user_message", data: `m${i}` }));
      }
      await Promise.all(jobs);
      const lines = readFileSync(join(dirA, "s1.jsonl"), "utf-8").trim().split("\n");
      const payloads = lines.map((l) => JSON.parse(l) as { data: string }).map((e) => e.data);
      expect(payloads).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
    }
  });

  it("目录未变时返回同一实例(缓存生效)", () => {
    const dir = mkdtempSync(join(tmpdir(), "daw-factory-b-"));
    try {
      const factory = createCachedSessionStoreFactory(() => dir);
      expect(factory()).toBe(factory());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录变化(切换空间)→ 重建实例且互不串扰", async () => {
    let current = mkdtempSync(join(tmpdir(), "daw-factory-c1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "daw-factory-c2-"));
    try {
      const factory = createCachedSessionStoreFactory(() => current);
      const first = factory();
      current = dir2;
      const second = factory();
      expect(second).not.toBe(first);
      await second.append({ ts: "t", sessionId: "s2", type: "user_message", data: "x" });
      expect(readdirSync(dir2)).toContain("s2.jsonl");
      expect(readdirSync(join(current === dir2 ? dir2 : current))).not.toContain("s1.jsonl");
    } finally {
      rmSync(current, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
