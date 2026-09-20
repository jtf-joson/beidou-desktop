/**
 * P1-3 协议层 · 工具访问策略:进入执行前的一致裁决点。
 * 与桌面壳「身份贯穿业务工具」同语义:未登录即拒绝业务查询;
 * 身份工具(login/status)始终放行(否则永远无法登录)。
 * 裁决结果进入 telemetry(AuditEventV2.policyDecision)与 BeidouToolResult.code。
 */
export interface PolicyInput {
  tool: string;
  identity?: { username: string; source: string };
}

export interface PolicyDecision {
  decision: "allow" | "deny";
  code?: "AUTH_REQUIRED";
  reason?: string;
}

const IDENTITY_TOOLS = new Set(["beidou_login", "beidou_auth_status"]);

export function decideToolAccess(input: PolicyInput): PolicyDecision {
  if (IDENTITY_TOOLS.has(input.tool)) return { decision: "allow" };
  if (!input.identity || !input.identity.username) {
    return {
      decision: "deny",
      code: "AUTH_REQUIRED",
      reason: "未登录:请先调用 beidou_login 完成理想 IDaaS 登录,再执行业务查询",
    };
  }
  return { decision: "allow" };
}
