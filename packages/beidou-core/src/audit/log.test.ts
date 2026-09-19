import { describe, expect, it } from "vitest";
import { createAuditLog } from "./log";
import type { AuditEvent } from "../types";

const ev = (i: number): AuditEvent => ({
  ts: `2026-09-17T12:00:${String(i).padStart(2, "0")}Z`,
  kind: "tool_call",
  sessionId: "s1",
  summary: `事件${i}`,
});

describe("createAuditLog JSONL 审计", () => {
  it("append 写 JSONL(一行一事件),tail 读最近 N 条(顺序保持)", async () => {
    const written: string[] = [];
    let content = "";
    const log = createAuditLog({
      appendFile: async (line) => {
        written.push(line);
        content += line;
      },
      readFile: async () => content,
    });
    await log.append(ev(1));
    await log.append(ev(2));
    await log.append(ev(3));
    expect(written).toHaveLength(3);
    expect(written[0]).toContain("事件1");
    const tail = await log.tail(2);
    expect(tail.map((e) => e.summary)).toEqual(["事件2", "事件3"]);
  });

  it("文件不存在时 tail 返回空数组(不抛错)", async () => {
    const log = createAuditLog({
      appendFile: async () => {},
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await log.tail(10)).toEqual([]);
  });

  it("坏行(历史脏数据)被跳过而不是炸掉", async () => {
    const log = createAuditLog({
      appendFile: async () => {},
      readFile: async () => '{"ts":"x","kind":"tool_call","sessionId":"s","summary":"ok"}\nnot-json\n',
    });
    const tail = await log.tail(10);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.summary).toBe("ok");
  });

  it("append 前自动脱敏(CODE_STANDARDS §4)", async () => {
    const written: string[] = [];
    const log = createAuditLog({ appendFile: async (l) => void written.push(l), readFile: async () => "" });
    await log.append({ ...ev(9), detail: { password: "p", safe: 1 } });
    expect(written[0]).not.toContain('"p"');
    expect(written[0]).toContain('"***"');
  });
});
