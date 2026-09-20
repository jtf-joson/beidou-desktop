/**
 * P1-3 协议单轨测试:错误归类 / 策略裁决 / core→BeidouToolResult 转换 / 遥测事件。
 */
import { describe, expect, it, vi } from "vitest";
import { classifyError } from "./errors";
import { decideToolAccess } from "./policy";
import { toBeidouResult, renderBeidouResult } from "./adapter";
import { toToolValue } from "./schemas";
import { createTelemetrySink, withTelemetry } from "./telemetry";
import { ERROR_CODES } from "@beidou/contracts";

describe("classifyError(错误单轨归类)", () => {
  it("括号内契约码直通", () => {
    expect(classifyError("口径编译失败(BINDING_NOT_FOUND):找不到绑定")).toBe("BINDING_NOT_FOUND");
    expect(classifyError("SQL 构建拒绝(QUERY_REJECTED):表不在白名单")).toBe("QUERY_REJECTED");
  });
  it("自然语言模式归类", () => {
    expect(classifyError("连接 StarRocks 失败:ECONNREFUSED")).toBe("DATA_SOURCE_UNAVAILABLE");
    expect(classifyError("查询超时")).toBe("QUERY_TIMEOUT");
    expect(classifyError("知识库中未找到该条目")).toBe("KNOWLEDGE_NOT_FOUND");
    expect(classifyError("未找到指标 mc_x")).toBe("METRIC_UNAVAILABLE");
    expect(classifyError("用户未登录")).toBe("AUTH_REQUIRED");
  });
  it("无法归类 → INTERNAL_ERROR;空错误 → INTERNAL_ERROR", () => {
    expect(classifyError("完全未知的问题")).toBe("INTERNAL_ERROR");
    expect(classifyError()).toBe("INTERNAL_ERROR");
  });
  it("归类结果都在 12 个契约错误码内", () => {
    const samples = ["未登录 x", "已过期", "无权限", "参数缺失", "本体校验失败", "绑定缺失", "指标未找到", "连接失败", "被护栏拒绝", "超时", "知识库未找到", "其他"];
    for (const s of samples) expect(ERROR_CODES).toContain(classifyError(s));
  });
});

describe("decideToolAccess(策略裁决)", () => {
  it("身份工具始终放行(否则无法登录)", () => {
    expect(decideToolAccess({ tool: "beidou_login" }).decision).toBe("allow");
    expect(decideToolAccess({ tool: "beidou_auth_status" }).decision).toBe("allow");
  });
  it("业务工具未登录 → deny + AUTH_REQUIRED", () => {
    const r = decideToolAccess({ tool: "query_metrics" });
    expect(r.decision).toBe("deny");
    expect(r.code).toBe("AUTH_REQUIRED");
    expect(r.reason).toContain("beidou_login");
  });
  it("已登录 → allow", () => {
    expect(decideToolAccess({ tool: "query_metrics", identity: { username: "owner", source: "idaas-token" } }).decision).toBe("allow");
  });
});

describe("toBeidouResult(单轨转换)", () => {
  it("成功:text→message,mock 证据 → warnings", () => {
    const r = toBeidouResult(
      { ok: true, text: "结果如下", evidence: [{ kind: "metric_query", title: "t", mock: true }] },
      { tool: "query_metrics", traceId: "btr-1" },
    );
    expect(r).toMatchObject({ ok: true, code: "OK", message: "结果如下", traceId: "btr-1" });
    expect(r.warnings).toEqual([expect.stringContaining("mock")]);
    expect(r.evidence).toHaveLength(1);
  });
  it("失败:error 文本 → 机器码 + message", () => {
    const r = toBeidouResult({ ok: false, text: "", error: "口径编译失败(METRIC_UNAVAILABLE):xxx" }, { tool: "query_metrics", traceId: "btr-2" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("METRIC_UNAVAILABLE");
    expect(r.message).toContain("口径编译失败");
  });
  it("toToolValue:可空字段收敛为空值(dsh 全必填约定)", () => {
    const v = toToolValue({ ok: true, code: "OK", message: "m", traceId: "t" });
    expect(v.data).toEqual({});
    expect(v.warnings).toEqual([]);
    expect(v.evidence).toEqual([]);
  });
  it("render:失败输出机器可判别 JSON;成功附警示", () => {
    const fail = renderBeidouResult({}, { ok: false, code: "AUTH_REQUIRED", message: "未登录", traceId: "t" });
    expect(JSON.parse(fail[0]!.text)).toEqual({ code: "AUTH_REQUIRED", message: "未登录", traceId: "t" });
    const ok = renderBeidouResult({}, { ok: true, code: "OK", message: "答案", warnings: ["演示数据"], traceId: "t" });
    expect(ok[0]!.text).toContain("答案");
    expect(ok[0]!.text).toContain("演示数据");
  });
});

describe("telemetry(V2 事件)", () => {
  it("成功路径产出 OK 事件(含时长/traceId/policyDecision)", async () => {
    const events: unknown[] = [];
    const sink = createTelemetrySink({ sessionId: "s1", log: () => undefined, audit: { append: async (e) => { events.push(e); } } });
    const r = await withTelemetry(sink, { traceId: "btr-9", sessionId: "s1", tool: "query_metrics", inputSummary: "{}", userId: "owner", policyDecision: "allow" },
      async () => ({ ok: true, code: "OK" as const }));
    expect(r.ok).toBe(true);
    const e = events[0] as { detail: { resultCode: string; traceId: string; durationMs: number } };
    expect(e.detail.resultCode).toBe("OK");
    expect(e.detail.traceId).toBe("btr-9");
    expect(e.detail.durationMs).toBeGreaterThanOrEqual(0);
  });
  it("抛错路径产出 INTERNAL_ERROR 事件并原样上抛", async () => {
    const events: unknown[] = [];
    const sink = createTelemetrySink({ sessionId: "s1", log: () => undefined, audit: { append: async (e) => { events.push(e); } } });
    await expect(withTelemetry(sink, { traceId: "btr-10", sessionId: "s1", tool: "t", inputSummary: "", userId: "u", policyDecision: "allow" },
      async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const e = events[0] as { detail: { resultCode: string } };
    expect(e.detail.resultCode).toBe("INTERNAL_ERROR");
  });
  it("sink 落盘失败不阻塞工具结果", async () => {
    const sink = createTelemetrySink({ sessionId: "s1", log: () => undefined, audit: { append: async () => { throw new Error("disk full"); } } });
    const r = await withTelemetry(sink, { traceId: "t", sessionId: "s", tool: "t", inputSummary: "", userId: "u", policyDecision: "allow" },
      async () => ({ ok: true, code: "OK" as const }));
    expect(r.ok).toBe(true);
  });
  it("telemetry 不抛错(append 内部吞错)", async () => {
    const sink = createTelemetrySink({ sessionId: "s1", log: () => undefined });
    const spy = vi.fn();
    await expect((async () => { await sink.append({ timestamp: "t", traceId: "x", sessionId: "s", userId: "u", tool: "t", resultCode: "OK" }); spy(); })()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});
