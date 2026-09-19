/**
 * 身份模块:复用本机 ept(IDaaS)登录态 → 北斗work 身份。
 * 登录方案:与 ept 同源的理想 IDaaS OAuth(飞书扫码);会话文件 ~/.config/ept/auth_session.json。
 * 北斗(AnyMetrics)鉴权即 UID(auth-value = 账号名),拿到身份即可按用户权限拉资产。
 * fail-closed:会话缺失/字段缺失 → 无身份,应用进入未登录态。
 */
import { err, ok, type Result } from "../types";

export interface Identity {
  /** 登录账号(= AnyMetrics auth-value / UID) */
  username: string;
  /** 姓名(id_token.nickname) */
  name?: string;
  email?: string;
  expiresAt?: string;
  source: "ept-session" | "idaas-token" | "none";
}

interface EptSession {
  access_token?: string;
  id_token?: string;
  expires_at?: string;
  account?: { label?: string; email?: string; username?: string };
}

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1]!;
    payload = payload.replace(/-/g, "+").replace(/_/g, "/");
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export function identityFromEptSession(raw: unknown): Result<Identity> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return err("IDENTITY_NO_SESSION", "无 ept 登录会话");
  }
  const s = raw as EptSession;
  if (!s.access_token || !s.account?.username) {
    return err("IDENTITY_INVALID", "会话缺少 access_token 或账号信息");
  }
  const claims = s.id_token ? decodeJwtPayload(s.id_token) : null;
  const name = typeof claims?.nickname === "string" ? claims.nickname : undefined;
  return ok({
    username: s.account.username,
    name,
    email: s.account.email ?? (typeof claims?.email === "string" ? claims.email : undefined),
    expiresAt: s.expires_at,
    source: "ept-session",
  });
}

/** 过期判断:提前 5 分钟视为过期(刷新窗口);无过期时间不过期 */
export function isExpired(identity: Pick<Identity, "expiresAt">, now: Date = new Date()): boolean {
  if (!identity.expiresAt) return false;
  const exp = new Date(identity.expiresAt).getTime();
  if (Number.isNaN(exp)) return true; // P1-8:非法时间视为已过期(fail-closed)
  return now.getTime() >= exp - 5 * 60 * 1000;
}
