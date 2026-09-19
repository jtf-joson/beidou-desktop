/**
 * EvidencePack 组装与脱敏(DataBuddy EvidencePack 的单机版,SPEC S4.2)。
 */
import type { EvidenceItem, EvidenceKind } from "../types";

export type EvidenceInput = Partial<EvidenceItem> & { kind: EvidenceKind; title: string };

export function buildEvidenceItem(input: EvidenceInput): EvidenceItem {
  return {
    kind: input.kind,
    title: input.title,
    caliber: input.caliber,
    sql: input.sql,
    physicalTables: input.physicalTables,
    metricName: input.metricName,
    rows: input.rows,
    truncated: input.truncated,
    elapsedMs: input.elapsedMs,
    lineage: input.lineage,
    semanticVersion: input.semanticVersion,
    mock: input.mock,
  };
}

const SENSITIVE_KEY = /(authorization|auth[_-]?value|auth[_-]?token|password|passwd|secret|cookie|token|api[_-]?key)/i;

/** 按键脱敏(递归对象);字符串输入则脱敏 Bearer/长 token 字样 */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
      .replace(/\b(eyJ[A-Za-z0-9._-]{10,})\b/g, "***") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "***" : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}
