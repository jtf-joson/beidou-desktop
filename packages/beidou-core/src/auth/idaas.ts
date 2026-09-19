/**
 * IDaaS 认证(协议来自 ~/.codex/skills/idaas-auth-protocol/SKILL.md v1.0.4)。
 * 流程:POST /api/idaas/sessions 创建登录会话 → 用户浏览器打开 login_url 确认 →
 * 轮询 GET /api/idaas/sessions/{id} → success 后 GET /api/idaas/token-file 下载 token,
 * .tmp→rename 原子写缓存(app_id+open_id 键);服务端在过期前 300s 自动 refresh。
 * 硬约束:app_id 必填;4xx 时不得把错误响应写入本地 token 文件(fail-closed)。
 */
import { err, ok, type Result } from "../types";

export interface IdaasTokenFile {
  status: string;
  app_id: string;
  open_id: string;
  user_name?: string;
  identity_key?: string;
  authorization: string;
  expires_at?: string;
  updated_at?: string;
  source?: string;
}

export interface IdaasConfig {
  serviceUrl: string;
  /** 飞书机器人 app_id(必填,协议硬约束) */
  appId: string;
  /** 服务端启用鉴权时填写 */
  serviceToken?: string;
}

export interface IdaasDeps {
  fetchFn: typeof fetch;
  /** 原子写(.tmp → rename 由实现保证) */
  writeFileAtomic: (path: string, content: string) => Promise<void>;
  readFile: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export interface LoginResult {
  loginUrl: string;
  sessionId: string;
  token: IdaasTokenFile;
}

const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // 与服务端 300s 刷新窗口一致

export function createIdaasAuth(config: IdaasConfig, deps: IdaasDeps) {
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (config.serviceToken) h.Authorization = `Bearer ${config.serviceToken}`;
    return h;
  };

  const request = async <T>(path: string, init?: RequestInit): Promise<Result<T>> => {
    try {
      const resp = await deps.fetchFn(`${config.serviceUrl}${path}`, { headers: headers(), ...init });
      if (!resp.ok) return err("IDAAS_HTTP", `${path} → HTTP ${resp.status}`);
      return ok((await resp.json()) as T);
    } catch (e) {
      return err("IDAAS_NETWORK", e instanceof Error ? e.message : String(e));
    }
  };

  const tokenFilePath = (openId: string): string =>
    `auth/apps/${config.appId}/users/${encodeURIComponent(openId)}.json`;

  const isExpired = (t: IdaasTokenFile): boolean => {
    if (!t.expires_at) return false;
    const exp = new Date(t.expires_at).getTime();
    if (Number.isNaN(exp)) return false;
    return deps.now().getTime() >= exp - EXPIRY_MARGIN_MS;
  };

  const downloadToken = async (openId: string): Promise<Result<IdaasTokenFile>> => {
    const r = await request<IdaasTokenFile>(
      `/api/idaas/token-file?app_id=${encodeURIComponent(config.appId)}&open_id=${encodeURIComponent(openId)}`,
    );
    if (!r.ok) return err("IDAAS_TOKENFILE", `下载 token-file 失败:${r.error.message}`);
    // 协议:只有服务端 token 有效才会返回;本地原子写
    await deps.writeFileAtomic(tokenFilePath(openId), JSON.stringify(r.value, null, 2));
    return r;
  };

  return {
    tokenFilePath,

  /** 创建登录会话(拿到 login_url 先交给用户,再调 completeLogin) */
  async createLoginSession(input: { openId: string; userName: string }): Promise<Result<{ loginUrl: string; sessionId: string }>> {
    if (!config.appId) return err("IDAAS_NO_APP_ID", "缺少 IDAAS_AUTH_APP_ID(飞书机器人 app_id)");
    const created = await request<{ login_url?: string; session_id?: string }>("/api/idaas/sessions", {
      method: "POST",
      body: JSON.stringify({ app_id: config.appId, open_id: input.openId, user_name: input.userName }),
    });
    if (!created.ok) return err("IDAAS_SESSION", `创建登录会话失败:${created.error.message}`);
    if (!created.value.login_url || !created.value.session_id) {
      return err("IDAAS_SESSION", "会话响应缺少 login_url/session_id");
    }
    return ok({ loginUrl: created.value.login_url, sessionId: created.value.session_id });
  },

  /** 轮询会话直至用户确认,成功后下载并缓存 token */
  async completeLogin(input: {
    sessionId: string;
    openId: string;
    poll?: { intervalMs: number; maxAttempts: number };
  }): Promise<Result<IdaasTokenFile>> {
    if (!config.appId) return err("IDAAS_NO_APP_ID", "缺少 IDAAS_AUTH_APP_ID(飞书机器人 app_id)");
    const interval = input.poll?.intervalMs ?? 2000;
    const maxAttempts = input.poll?.maxAttempts ?? 150;
    for (let i = 0; i < maxAttempts; i++) {
      const st = await request<{ status?: string }>(`/api/idaas/sessions/${encodeURIComponent(input.sessionId)}`);
      if (!st.ok) return err("IDAAS_POLL", `查询登录状态失败:${st.error.message}`);
      const status = st.value.status;
      if (status === "success") return downloadToken(input.openId);
      if (status === "failed" || status === "expired") {
        return err("IDAAS_LOGIN_FAILED", `登录${status === "failed" ? "失败" : "会话过期"},请重试`);
      }
      await deps.sleep(interval);
    }
    return err("IDAAS_LOGIN_TIMEOUT", `等待用户确认超时(${maxAttempts} 次)`);
  },

  async login(input: {
    openId: string;
    userName: string;
    poll?: { intervalMs: number; maxAttempts: number };
  }): Promise<Result<LoginResult>> {
    const created = await this.createLoginSession(input);
    if (!created.ok) return created;
    const token = await this.completeLogin({ sessionId: created.value.sessionId, openId: input.openId, poll: input.poll });
    if (!token.ok) return token;
    return ok({ loginUrl: created.value.loginUrl, sessionId: created.value.sessionId, token: token.value });
  },

    async cachedToken(openId: string): Promise<Result<IdaasTokenFile>> {
      let text: string;
      try {
        text = await deps.readFile();
      } catch {
        return err("IDAAS_NO_CACHE", "无本地 token 缓存");
      }
      let parsed: IdaasTokenFile;
      try {
        parsed = JSON.parse(text) as IdaasTokenFile;
      } catch {
        return err("IDAAS_BAD_CACHE", "本地 token 缓存损坏");
      }
      if (!parsed.authorization) return err("IDAAS_BAD_CACHE", "缓存缺少 authorization");
      if (isExpired(parsed)) return err("IDAAS_TOKEN_EXPIRED", parsed.expires_at ?? "");
      return ok(parsed);
    },

    async refresh(input: { openId: string }): Promise<Result<IdaasTokenFile>> {
      if (!config.appId) return err("IDAAS_NO_APP_ID", "缺少 app_id");
      const r = await request<{ status?: string }>(
        `/api/idaas/tokens/refresh?app_id=${encodeURIComponent(config.appId)}&open_id=${encodeURIComponent(input.openId)}`,
        { method: "POST" },
      );
      if (!r.ok) return err("IDAAS_REFRESH", `刷新失败:${r.error.message}`);
      if (r.value.status !== "valid") return err("IDAAS_REFRESH", `刷新状态 ${r.value.status},需重新登录`);
      return downloadToken(input.openId);
    },
  };
}

export type IdaasAuth = ReturnType<typeof createIdaasAuth>;
