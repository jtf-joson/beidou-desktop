/**
 * 审核第一批修复测试:
 * P0-01 动态身份(wrapTool 每次调用现取,快照被覆盖/兜底)
 * P0-02 登录 Result 分支(失败不得记成功)
 * identity-provider:cachedToken → Identity 映射
 */
import { describe, expect, it } from "vitest";
import { createIdentityProvider } from "./identity-provider";
import { wrapTool } from "./tools";
import { settleLoginResult, getLoginTask } from "./idaas-tool";
import { createTelemetrySink } from "./telemetry";
import { ok, err } from "@beidou/core/src/types.ts";
import type { IdaasAuth } from "@beidou/core/src/auth/idaas.ts";

function fakeAuth(cached: { ok: true; value: { user_name?: string } } | { ok: false; error: { code: string; message: string } }): IdaasAuth {
  return { cachedToken: async () => cached } as unknown as IdaasAuth;
}

function sinkWith(events: unknown[]) {
  return createTelemetrySink({ sessionId: "s-test", audit: { append: async (e) => { events.push(e); } } });
}

describe("createIdentityProvider(P0-01 动态身份)", () => {
  it("cachedToken 有效 → Identity(user_name 缺省回退 openId)", async () => {
    const getId = createIdentityProvider(fakeAuth(ok({})), "owner");
    await expect(getId()).resolves.toEqual({ username: "owner", source: "idaas-token" });
    const getId2 = createIdentityProvider(fakeAuth(ok({ user_name: "zhangsan" })), "owner");
    await expect(getId2()).resolves.toEqual({ username: "zhangsan", source: "idaas-token" });
  });
  it("cachedToken 失败(无缓存/过期/损坏)→ null", async () => {
    for (const bad of [
      err("IDAAS_NO_CACHE", "无本地 token 缓存"),
      err("IDAAS_TOKEN_EXPIRED", ""),
      err("IDAAS_BAD_CACHE", "损坏"),
    ]) {
      const getId = createIdentityProvider(fakeAuth(bad), "owner");
      await expect(getId()).resolves.toBeNull();
    }
  });
});

describe("wrapTool(P0-01 身份每次调用动态解析)", () => {
  it("动态提供者返回 null 时,即使存在启动快照也拒绝(AUTH_REQUIRED)", async () => {
    const events: unknown[] = [];
    const r = await wrapTool({
      name: "query_metrics", args: {} as Record<string, never>,
      handler: async () => ({ ok: true, text: "不应到达" }),
      telemetry: sinkWith(events), sessionId: "s-test",
      identity: { username: "stale-snapshot", source: "idaas-token" }, // 登录前的陈旧快照
      getIdentity: async () => null, // 登录后未落盘/已过期
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("AUTH_REQUIRED");
    const e = (events[0] as { detail: { userId: string; policyDecision: string; resultCode: string } }).detail;
    expect(e.userId).toBe("anonymous");
    expect(e.resultCode).toBe("AUTH_REQUIRED");
  });
  it("动态提供者返回新身份 → 放行,遥测 userId 取动态值", async () => {
    const events: unknown[] = [];
    const r = await wrapTool({
      name: "query_metrics", args: {} as Record<string, never>,
      handler: async () => ({ ok: true, text: "done" }),
      telemetry: sinkWith(events), sessionId: "s-test",
      getIdentity: async () => ({ username: "fresh-login", source: "idaas-token" }),
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("OK");
    const e = (events[0] as { detail: { userId: string; policyDecision: string } }).detail;
    expect(e.userId).toBe("fresh-login");
    expect(e.policyDecision).toBe("allow");
  });
  it("同一会话内身份变化即时生效:先 null 拒绝,后有效放行(无需重启)", async () => {
    const events: unknown[] = [];
    let current: { username: string; source: string } | null = null; // 模拟 beidou_login 落盘
    const opts = {
      name: "query_metrics", args: {} as Record<string, never>,
      handler: async () => ({ ok: true, text: "done" }),
      telemetry: sinkWith(events), sessionId: "s-test",
      getIdentity: async () => current,
    };
    const denied = await wrapTool(opts);
    expect(denied.code).toBe("AUTH_REQUIRED");
    current = { username: "after-login", source: "idaas-token" };
    const allowed = await wrapTool(opts);
    expect(allowed.code).toBe("OK");
  });
  it("未提供动态提供者 → 回退启动快照(兼容)", async () => {
    const events: unknown[] = [];
    const r = await wrapTool({
      name: "query_metrics", args: {} as Record<string, never>,
      handler: async () => ({ ok: true, text: "done" }),
      telemetry: sinkWith(events), sessionId: "s-test",
      identity: { username: "snapshot", source: "idaas-token" },
    });
    expect(r.ok).toBe(true);
    const e = (events[0] as { detail: { userId: string } }).detail;
    expect(e.userId).toBe("snapshot");
  });
  it("handler 抛错 → 上抛,遥测记 INTERNAL_ERROR 且 userId 为动态身份", async () => {
    const events: unknown[] = [];
    await expect(wrapTool({
      name: "query_metrics", args: {} as Record<string, never>,
      handler: async () => { throw new Error("boom"); },
      telemetry: sinkWith(events), sessionId: "s-test",
      getIdentity: async () => ({ username: "u1", source: "idaas-token" }),
    })).rejects.toThrow("boom");
    const e = (events[0] as { detail: { userId: string; resultCode: string } }).detail;
    expect(e.userId).toBe("u1");
    expect(e.resultCode).toBe("INTERNAL_ERROR");
  });
});

describe("settleLoginResult(P0-02 登录 Result 分支)", () => {
  it("ok:false(失败/超时)→ 状态 failed,不记成功", () => {
    settleLoginResult(err("IDAAS_LOGIN_TIMEOUT", "等待用户确认超时(100 次)"));
    expect(getLoginTask()).toMatchObject({ status: "failed", error: "等待用户确认超时(100 次)" });
    settleLoginResult(err("IDAAS_LOGIN_FAILED", "登录失败"));
    expect(getLoginTask()).toMatchObject({ status: "failed" });
  });
  it("ok:true → 状态 success", () => {
    settleLoginResult(ok({ status: "valid", authorization: "Bearer x" }));
    expect(getLoginTask()).toMatchObject({ status: "success" });
  });
});
