import { describe, expect, it } from "vitest";
import { createIdaasAuth, type IdaasDeps } from "./idaas";

function makeDeps(responses: Array<{ url: string; method?: string; status?: number; body: unknown }>): {
  deps: IdaasDeps;
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let i = 0;
  const deps: IdaasDeps = {
    fetchFn: (async (url: any, init: any) => {
      const call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch,
    writeFileAtomic: async () => {},
    readFile: async () => {
      throw new Error("ENOENT");
    },
    sleep: async () => {},
    now: () => new Date("2026-09-18T08:00:00Z"),
  };
  return { deps, calls };
}

const CFG = { serviceUrl: "https://auth.example", appId: "cli_test" };

describe("IDaaS auth-service 客户端(idaas-auth-protocol 协议)", () => {
  it("登录全流程:建会话 → 轮询 success → 下载 token-file → 原子缓存", async () => {
    const { deps, calls } = makeDeps([
      { url: "", body: { login_url: "https://idaas/login?x=1", session_id: "sess-1" } },
      { url: "", body: { status: "success" } },
      {
        url: "",
        body: {
          status: "valid", app_id: "cli_test", open_id: "demo_user", user_name: "demo_user",
          identity_key: "cli_test:demo_user", authorization: "Bearer eyJabc",
          expires_at: "2026-09-18T20:00:00Z", updated_at: "2026-09-18T08:00:00Z", source: "idaas-auth-service",
        },
      },
    ]);
    const auth = createIdaasAuth(CFG, deps);
    const r = await auth.login({ openId: "demo_user", userName: "demo_user" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.loginUrl).toContain("idaas/login");
    expect(r.value.token.authorization).toBe("Bearer eyJabc");
    // 协议端点与顺序
    expect(calls[0]!.url).toBe("https://auth.example/api/idaas/sessions");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ app_id: "cli_test", open_id: "demo_user", user_name: "demo_user" });
    expect(calls[1]!.url).toContain("/api/idaas/sessions/sess-1");
    expect(calls[2]!.url).toContain("/api/idaas/token-file?app_id=cli_test&open_id=demo_user");
  });

  it("轮询 pending → failed 超次后中止并报错(fail-closed)", async () => {
    const { deps } = makeDeps([
      { url: "", body: { login_url: "https://l", session_id: "s" } },
      { url: "", body: { status: "pending" } },
    ]);
    const auth = createIdaasAuth(CFG, deps);
    const r = await auth.login({ openId: "u", userName: "u", poll: { intervalMs: 0, maxAttempts: 3 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDAAS_LOGIN_TIMEOUT");
  });

  it("会话 failed → 立即报错", async () => {
    const { deps } = makeDeps([
      { url: "", body: { login_url: "https://l", session_id: "s" } },
      { url: "", body: { status: "failed" } },
    ]);
    const r = await createIdaasAuth(CFG, deps).login({ openId: "u", userName: "u", poll: { intervalMs: 0, maxAttempts: 5 } });
    expect(r.ok).toBe(false);
  });

  it("cachedToken:读本地缓存,未过期直接可用", async () => {
    const token = {
      status: "valid", app_id: "cli_test", open_id: "demo_user", user_name: "demo_user",
      authorization: "Bearer cached", expires_at: "2026-09-18T20:00:00Z",
    };
    const { deps } = makeDeps([]);
    deps.readFile = async () => JSON.stringify(token);
    const r = await createIdaasAuth(CFG, deps).cachedToken("demo_user");
    expect(r).toEqual({ ok: true, value: token });
  });

  it("cachedToken:本地过期 → 返回过期标记(调用方决定 refresh/重登)", async () => {
    const token = { status: "valid", authorization: "Bearer x", expires_at: "2026-09-18T07:59:00Z" };
    const { deps } = makeDeps([]);
    deps.readFile = async () => JSON.stringify(token);
    const r = await createIdaasAuth(CFG, deps).cachedToken("demo_user");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDAAS_TOKEN_EXPIRED");
  });

  it("cachedToken:expires_at 非法/缺失 → fail-closed 视为过期(审核 P0-08)", async () => {
    for (const bad of ["not-a-date", "", undefined]) {
      const token = { status: "valid", authorization: "Bearer x", expires_at: bad };
      const { deps } = makeDeps([]);
      deps.readFile = async () => JSON.stringify(token);
      const r = await createIdaasAuth(CFG, deps).cachedToken("demo_user");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("IDAAS_TOKEN_EXPIRED");
    }
  });

  it("cachedToken:距过期不足 5 分钟(刷新窗口内)→ 视为过期", async () => {
    const token = { status: "valid", authorization: "Bearer x", expires_at: "2026-09-18T08:03:00Z" };
    const { deps } = makeDeps([]);
    deps.readFile = async () => JSON.stringify(token);
    const r = await createIdaasAuth(CFG, deps).cachedToken("demo_user");
    expect(r.ok).toBe(false);
  });

  it("refresh:服务端续期后重新下载并覆盖缓存", async () => {
    const { deps, calls } = makeDeps([
      { url: "", body: { status: "valid" } },
      { url: "", body: { status: "valid", app_id: "cli_test", open_id: "u", authorization: "Bearer new", expires_at: "2026-09-19T08:00:00Z" } },
    ]);
    const r = await createIdaasAuth(CFG, deps).refresh({ openId: "u" });
    expect(r.ok).toBe(true);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/api/idaas/tokens/refresh");
    if (r.ok) expect(r.value.authorization).toBe("Bearer new");
  });

  it("下载失败(4xx)不污染缓存(fail-closed,原子写)", async () => {
    let wrote = "";
    const { deps } = makeDeps([
      { url: "", body: { login_url: "https://l", session_id: "s" } },
      { url: "", body: { status: "success" } },
      { url: "", status: 404, body: { error: "missing" } },
    ]);
    deps.writeFileAtomic = async (p, c) => {
      wrote = p;
      void c;
    };
    const r = await createIdaasAuth(CFG, deps).login({ openId: "u", userName: "u", poll: { intervalMs: 0, maxAttempts: 3 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDAAS_TOKENFILE");
    expect(wrote).toBe(""); // 失败时不应写任何文件
  });

  it("缺 app_id → 拒绝发起(协议硬约束)", async () => {
    const { deps } = makeDeps([]);
    const r = await createIdaasAuth({ serviceUrl: "https://x", appId: "" }, deps).login({ openId: "u", userName: "u" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDAAS_NO_APP_ID");
  });
});
