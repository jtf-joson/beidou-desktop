/**
 * P1-3 协议层 · 错误归类:core 自然语言错误 → 机器可判别 ErrorCode。
 * 规则:先精确(括号内 code/前缀),后模式;兜底 INTERNAL_ERROR。
 * Agent 与调用方不得解析自然语言错误——一律以 code 分支。
 */
import type { ErrorCode } from "@beidou/contracts/src/index.ts";

/** 括号内裸 code,如「口径编译失败(METRIC_NOT_FOUND):…」「SQL 构建拒绝(BAD_LIMIT):…」 */
const CODE_IN_PARENS = /[((]([A-Z][A-Z0-9_]{3,})\s*[:)]/;

/** core 已有机器码 → 契约错误码 的直通表(名字相同即直通) */
const PASSTHROUGH = new Set<string>([
  "AUTH_REQUIRED", "AUTH_EXPIRED", "FORBIDDEN",
  "INVALID_INPUT", "ONTOLOGY_INVALID", "BINDING_NOT_FOUND",
  "METRIC_UNAVAILABLE", "DATA_SOURCE_UNAVAILABLE",
  "QUERY_REJECTED", "QUERY_TIMEOUT", "KNOWLEDGE_NOT_FOUND",
  "INTERNAL_ERROR",
]);

/** core 语义前缀/模式 → 契约错误码 */
const PATTERNS: Array<{ re: RegExp; code: ErrorCode }> = [
  { re: /未登录|无身份|AUTH_REQUIRED|auth.*required/i, code: "AUTH_REQUIRED" },
  { re: /过期|expired|AUTH_EXPIRED/i, code: "AUTH_EXPIRED" },
  { re: /无权限|禁止|forbidden|rbac/i, code: "FORBIDDEN" },
  { re: /参数|invalid input|必填|类型不符/i, code: "INVALID_INPUT" },
  { re: /本体|ontology|schema 校验/i, code: "ONTOLOGY_INVALID" },
  { re: /绑定|binding|表指针/i, code: "BINDING_NOT_FOUND" },
  { re: /指标未找到|未找到指标|口径编译失败|metric.*not found|METRIC_NOT_FOUND/i, code: "METRIC_UNAVAILABLE" },
  { re: /连接|ECONNREFUSED|ETIMEDOUT|connect|数据源|datasource/i, code: "DATA_SOURCE_UNAVAILABLE" },
  { re: /SQL 构建拒绝|护栏|guard|白名单|拒绝/i, code: "QUERY_REJECTED" },
  { re: /超时|timeout/i, code: "QUERY_TIMEOUT" },
  { re: /知识库|playbook|未找到.*(知识|手册)|KNOWLEDGE/i, code: "KNOWLEDGE_NOT_FOUND" },
];

export function classifyError(err?: string): ErrorCode {
  if (!err) return "INTERNAL_ERROR";
  const m = CODE_IN_PARENS.exec(err);
  if (m?.[1] && PASSTHROUGH.has(m[1])) return m[1] as ErrorCode;
  for (const p of PATTERNS) {
    if (p.re.test(err)) return p.code;
  }
  return "INTERNAL_ERROR";
}
