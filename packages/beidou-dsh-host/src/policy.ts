/**
 * 协议层 · 工具访问策略:进入执行前的一致裁决点。
 * 审核七轮 P0-08:第一道为**工具名正向白名单**(执行层防线)——不在北斗注册集合内
 * 的工具一律 TOOL_NOT_ALLOWED(配置错误/越权注册 fail-closed);配置层的
 * profile 禁用清单见 profiles/beidou-common/cordis.patch.yml,CI 断言见
 * scripts/check-dsh-tool-boundary.mjs,三层互补。
 * 第二道为身份门禁:未登录拒绝需要用户数据权限的工具;已配置企业服务凭据时，
 * 只读语义/指标链路可直接执行。身份工具(login/status)始终放行。
 * 裁决结果进入 telemetry(AuditEventV2.policyDecision)与 BeidouToolResult.code。
 */
import type { ErrorCode } from "@beidou/contracts/src/index.ts";

export interface PolicyInput {
  tool: string;
  identity?: { username: string; source: string };
  serviceAuth?: boolean;
}

export interface PolicyDecision {
  decision: "allow" | "deny";
  code?: ErrorCode;
  reason?: string;
}

export const IDENTITY_TOOLS = new Set(["beidou_login", "beidou_auth_status"]);

/** AnyMetrics 服务凭据已由工作区配置提供的只读工具，不要求重复交互登录。 */
export const SERVICE_AUTH_TOOLS = new Set([
  "search_semantics", "query_metrics", "diagnose_metric", "trace_lineage",
  "search_knowledge", "read_playbook", "list_ontology",
]);

/** 北斗注册的 9 个业务工具(正向白名单;新增工具必须显式登记于此) */
export const BUSINESS_TOOLS = new Set([
  "search_semantics", "query_metrics", "query_dataset", "clarify",
  "diagnose_metric", "trace_lineage", "search_knowledge", "read_playbook", "list_ontology",
]);

/** 完整允许集合 = 业务 + 身份(注册层断言用) */
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set([...BUSINESS_TOOLS, ...IDENTITY_TOOLS]);

export function decideToolAccess(input: PolicyInput): PolicyDecision {
  // P0-08:工具名正向白名单——多一个、少一个都不该执行
  if (!ALLOWED_TOOLS.has(input.tool)) {
    return {
      decision: "deny",
      code: "TOOL_NOT_ALLOWED",
      reason: `工具 ${input.tool} 不在北斗白名单内(白名单=9 业务+2 身份;此拒绝通常意味着 profile 配置漂移或越权注册)`,
    };
  }
  if (IDENTITY_TOOLS.has(input.tool)) return { decision: "allow" };
  if (input.serviceAuth && SERVICE_AUTH_TOOLS.has(input.tool)) return { decision: "allow" };
  if (!input.identity || !input.identity.username) {
    return {
      decision: "deny",
      code: "AUTH_REQUIRED",
      reason: "未登录:请先调用 beidou_login 完成理想 IDaaS 登录,再执行业务查询",
    };
  }
  return { decision: "allow" };
}
