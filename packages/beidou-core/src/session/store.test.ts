import { describe, expect, it, beforeEach } from "vitest";
import { SessionStore, assertSafeSessionId, type SessionEvent } from "./store";
import { replayEvents, bubblesToEvents } from "./replay";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let DIR = "";
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "daw-session-"));
  return () => rmSync(DIR, { recursive: true, force: true });
});

describe("SessionStore(JSONL 持久化)", () => {
  const store = () => new SessionStore(DIR);

  it("append + read:事件完整回读", async () => {
    const ev: SessionEvent = { ts: "2026-09-20T10:00:00Z", type: "user_message", sessionId: "s1", data: "你好" };
    await store().append(ev);
    const read = await store().read("s1");
    expect(read).toHaveLength(1);
    expect(read[0]!.data).toBe("你好");
  });

  it("list:返回摘要(标题=首条用户消息),按时间倒序", async () => {
    await store().append({ ts: "2026-09-20T11:00:00Z", type: "user_message", sessionId: "s2", data: "查高速智驾" });
    await store().append({ ts: "2026-09-20T12:00:00Z", type: "user_message", sessionId: "s1", data: "你好" });
    const list = await store().list();
    expect(list.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(list.find((s) => s.id === "s2")?.title).toBe("查高速智驾");
    expect(list.find((s) => s.id === "s2")?.messageCount).toBe(1);
  });

  it("空/不存在 session → read 返回 []", async () => {
    expect(await store().read("nonexistent")).toEqual([]);
  });

  it("delete 真删除(文件移除,list 不再出现)", async () => {
    await store().append({ ts: "2026-09-20T11:00:00Z", type: "user_message", sessionId: "s2", data: "x" });
    await store().delete("s2");
    expect(await store().read("s2")).toEqual([]);
    expect((await store().list()).find((s) => s.id === "s2")).toBeUndefined();
  });

  it("路径穿越:sessionId 带路径分隔符被拒", async () => {
    await expect(store().read("../../etc/passwd")).rejects.toThrow(/invalid sessionId/);
    await expect(store().append({ ts: "t", type: "user_message", sessionId: "a/b", data: "x" })).rejects.toThrow(/invalid sessionId/);
    await expect(store().delete("..")).rejects.toThrow(/invalid sessionId/);
    expect(() => assertSafeSessionId("x".repeat(81))).toThrow(/invalid sessionId/);
  });

  it("损坏行(断电截断)跳过,其余事件完整回读", async () => {
    const s = store();
    await s.append({ ts: "2026-09-20T10:00:00Z", type: "user_message", sessionId: "s9", data: "完整行" });
    writeFileSync(join(DIR, "s9.jsonl"), '{"ts":"x","type":"user_mess', { flag: "a" }); // 截断行,无换行
    const read = await s.read("s9");
    expect(read).toHaveLength(1);
    expect(read[0]!.data).toBe("完整行");
  });
});

describe("replayEvents(回放与实时 reducer 同构)", () => {
  it("完整一轮:用户→工具→结果→回答→证据", () => {
    const events: SessionEvent[] = [
      { ts: "1", type: "user_message", sessionId: "s", data: "高速智驾天数?" },
      { ts: "2", type: "assistant_chunk", sessionId: "s", data: "" },
      { ts: "3", type: "tool_call", sessionId: "s", data: { name: "search_semantics", input: { query: "高速智驾天数?" } } },
      { ts: "4", type: "tool_result", sessionId: "s", data: { name: "search_semantics", ok: true, summary: "检索完成" } },
      { ts: "5", type: "tool_call", sessionId: "s", data: { name: "query_metrics", input: { metricName: "mc_highway_noa_days" } } },
      { ts: "6", type: "tool_result", sessionId: "s", data: { name: "query_metrics", ok: false, summary: "查询失败" } },
      { ts: "7", type: "assistant_chunk", sessionId: "s", data: "查询失败:…" },
      { ts: "8", type: "evidence", sessionId: "s", data: [{ kind: "metric_query", title: "高速智驾天数" }] },
      { ts: "9", type: "done", sessionId: "s", data: undefined },
    ];
    const bubbles = replayEvents(events);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toMatchObject({ role: "user", text: "高速智驾天数?" });
    const ai = bubbles[1]!;
    expect(ai.role).toBe("assistant");
    expect(ai.text).toBe("查询失败:…");
    expect(ai.tools).toHaveLength(2);
    expect(ai.tools![0]).toMatchObject({ name: "search_semantics", ok: true, summary: "检索完成", ts: "4" });
    expect(ai.tools![0]!.input).toEqual({ query: "高速智驾天数?" });
    expect(ai.tools![1]).toMatchObject({ ok: false, summary: "查询失败" });
    expect(ai.evidence).toEqual([{ kind: "metric_query", title: "高速智驾天数" }]);
  });

  it("assistant_chunk 整段替换;新用户消息开启新气泡组", () => {
    const events: SessionEvent[] = [
      { ts: "1", type: "user_message", sessionId: "s", data: "q1" },
      { ts: "2", type: "assistant_chunk", sessionId: "s", data: "流式中" },
      { ts: "3", type: "assistant_chunk", sessionId: "s", data: "最终答案" },
      { ts: "4", type: "user_message", sessionId: "s", data: "q2" },
      { ts: "5", type: "assistant_chunk", sessionId: "s", data: "答2" },
    ];
    const bubbles = replayEvents(events);
    expect(bubbles.map((b) => `${b.role}:${b.text}`)).toEqual(["user:q1", "assistant:最终答案", "user:q2", "assistant:答2"]);
  });

  it("error 事件落到当前 assistant 气泡的 error 字段", () => {
    const events: SessionEvent[] = [
      { ts: "1", type: "user_message", sessionId: "s", data: "q" },
      { ts: "2", type: "assistant_chunk", sessionId: "s", data: "" },
      { ts: "3", type: "error", sessionId: "s", data: "模型超时" },
    ];
    const bubbles = replayEvents(events);
    expect(bubbles[1]!.error).toBe("模型超时");
  });

  it("空事件流 → 空气泡流", () => {
    expect(replayEvents([])).toEqual([]);
  });
});

describe("bubblesToEvents(localStorage 迁移)", () => {
  it("气泡 → 事件 → 回放 = 原气泡(round-trip)", () => {
    const bubbles = [
      { role: "user" as const, text: "q1" },
      {
        role: "assistant" as const, text: "答1",
        tools: [
          { name: "search_semantics", ok: true, summary: "检索完成" },
          { name: "query_metrics", ok: false, summary: "失败" },
        ],
        evidence: [{ kind: "metric_query" as const, title: "t" }],
      },
    ];
    const events = bubblesToEvents("mig1", bubbles);
    // 事件时序:user → tool_call/result ×2 → assistant → evidence
    expect(events.map((e) => e.type)).toEqual([
      "user_message", "tool_call", "tool_result", "tool_call", "tool_result", "assistant_chunk", "evidence",
    ]);
    const back = replayEvents(events);
    expect(back).toHaveLength(2);
    expect(back[1]!.text).toBe("答1");
    expect(back[1]!.tools).toHaveLength(2);
    expect(back[1]!.tools![1]).toMatchObject({ ok: false, summary: "失败" });
    expect(back[1]!.evidence).toEqual([{ kind: "metric_query", title: "t" }]);
  });

  it("迁移后各会话可被 list 识别", async () => {
    const s = new SessionStore(DIR);
    for (const ev of bubblesToEvents("mig2", [{ role: "user", text: "旧会话问题" }, { role: "assistant", text: "旧答案" }])) {
      await s.append(ev);
    }
    const list = await s.list();
    expect(list.find((x) => x.id === "mig2")?.title).toBe("旧会话问题");
  });
});

describe("审核第二批修复回归(用户实测触发的两个 bug)", () => {
  it("并发 append 不乱序:同一会话连发 30 个事件,落盘顺序=提交顺序", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daw-store-order-"));
    const store = new SessionStore(dir);
    const sid = "s-order";
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 30; i++) {
      jobs.push(store.append({ ts: new Date(Date.now() + i).toISOString(), sessionId: sid, type: i % 2 === 0 ? "user_message" : "assistant_chunk", data: `m${i}` }));
    }
    await Promise.all(jobs);
    const events = await store.read(sid);
    expect(events.map((e) => String(e.data))).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`));
  });

  it("回放跳过空 assistant_chunk:乱序占位块不再清空已有正文(永久 Spin 根因)", () => {
    const sid = "s-replay";
    const events: SessionEvent[] = [
      { ts: "t1", sessionId: sid, type: "user_message", data: "第一问" },
      { ts: "t2", sessionId: sid, type: "assistant_chunk", data: "第一轮回答" },
      // 第二轮占位块因历史乱序落在这里:
      { ts: "t3", sessionId: sid, type: "assistant_chunk", data: "" },
      { ts: "t4", sessionId: sid, type: "user_message", data: "第二问" },
      { ts: "t5", sessionId: sid, type: "assistant_chunk", data: "第二轮回答" },
    ];
    const bubbles = replayEvents(events);
    expect(bubbles).toHaveLength(4); // user/answer/user/answer
    expect(bubbles[1]!.text).toBe("第一轮回答"); // 不被空块清空
    expect(bubbles[3]!.text).toBe("第二轮回答");
  });
});
