/**
 * 北斗work 统一协议层(P1-3)。所有工具/插件/审计共用;零运行时依赖。
 * 错误码为机器可判别常量——Agent 与调用方不得解析自然语言错误。
 */
export const ERROR_CODES = [
  "AUTH_REQUIRED", "AUTH_EXPIRED", "FORBIDDEN",
  "INVALID_INPUT", "ONTOLOGY_INVALID", "BINDING_NOT_FOUND",
  "METRIC_UNAVAILABLE", "DATA_SOURCE_UNAVAILABLE",
  "QUERY_REJECTED", "QUERY_TIMEOUT", "KNOWLEDGE_NOT_FOUND",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface EvidenceRef {
  kind: "metric_query" | "dataset_query" | "semantic_search" | "clarify";
  title: string;
  caliber?: string;
  sql?: string;
  lineage?: string[];
  rows?: number;
  truncated?: boolean;
  mock?: boolean;
  /** 脱敏标记:内容已经过统一脱敏管线(日志/审计/模型输出共用) */
  redacted?: boolean;
}

export interface BeidouToolResult<T = unknown> {
  ok: boolean;
  code: ErrorCode | "OK";
  data?: T;
  message?: string;
  warnings?: string[];
  evidence?: EvidenceRef[];
  traceId: string;
}

/** 统一审计事件(P1-5;JsonlAuditSink/RemoteAuditSink 共用) */
export interface AuditEventV2 {
  timestamp: string;
  traceId: string;
  sessionId: string;
  userId: string;
  tenantId?: string;
  tool: string;
  toolVersion?: string;
  inputSummary: string;
  policyDecision?: "allow" | "ask" | "deny" | "degraded";
  dataSources?: string[];
  knowledgeSources?: string[];
  durationMs?: number;
  resultCode: "OK" | ErrorCode;
}
