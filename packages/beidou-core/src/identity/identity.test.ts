import { describe, expect, it } from "vitest";
import { identityFromEptSession, isExpired } from "./identity";

const validSession = {
  access_token: "x".repeat(40),
  refresh_token: "r".repeat(20),
  id_token:
    "h." +
    Buffer.from(
      JSON.stringify({ nickname: "Demo User", leg: "demo_user" }),
    ).toString("base64url") +
    ".s",
  expires_at: "2026-09-19T10:00:00+08:00",
  account: { label: "demo_user", email: "demo_user@example.com", username: "demo_user" },
};

describe("identityFromEptSession(复用 IDaaS 登录态)", () => {
  it("完整会话 → 身份(username/姓名/邮箱/过期时间)", () => {
    const r = identityFromEptSession(validSession);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.username).toBe("demo_user");
    expect(r.value.name).toBe("Demo User");
    expect(r.value.email).toBe("demo_user@example.com");
    expect(r.value.source).toBe("ept-session");
    expect(r.value.expiresAt).toContain("2026-09-19");
  });

  it("无 id_token 时退化为 account 字段", () => {
    const r = identityFromEptSession({ ...validSession, id_token: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBeUndefined();
  });

  it("缺 account / 缺 access_token → fail-closed(无身份)", () => {
    expect(identityFromEptSession({ ...validSession, account: undefined }).ok).toBe(false);
    expect(identityFromEptSession({ ...validSession, access_token: undefined }).ok).toBe(false);
    expect(identityFromEptSession(null).ok).toBe(false);
    expect(identityFromEptSession("garbage").ok).toBe(false);
  });

  it("坏 id_token(非 JWT)→ 仍可用 account,不炸", () => {
    const r = identityFromEptSession({ ...validSession, id_token: "not-a-jwt" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBeUndefined();
  });
});

describe("isExpired", () => {
  it("过期判断(时区安全,含 5 分钟提前量)", () => {
    const id = { expiresAt: "2026-09-18T12:00:00+08:00" };
    expect(isExpired(id, new Date("2026-09-18T11:30:00+08:00"))).toBe(false);
    expect(isExpired(id, new Date("2026-09-18T11:58:00+08:00"))).toBe(true);
  });

  it("无过期时间 → 视为不过期(由刷新逻辑兜底)", () => {
    expect(isExpired({}, new Date())).toBe(false);
  });
});
