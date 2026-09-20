/**
 * adapter:P1-3 协议单轨的唯一边界——core ToolResponse → BeidouToolResult。
 * 旧 {ok,text,error} 双轨废止:插件内一切工具输出只有 BeidouToolResult 一种形状。
 */
import type { BeidouToolResult, EvidenceRef } from "@beidou/contracts";
import { randomUUID } from "node:crypto";
import { classifyError } from "./errors";

/** core 工具返回的结构性子集(与 beidou-core ToolResponse 兼容;evidence 为核心侧 EvidenceItem[]) */
export interface CoreToolResponse {
  ok: boolean;
  text: string;
  evidence?: unknown[];
  error?: string;
}

export function newTraceId(): string {
  return `btr-${randomUUID()}`;
}

/**
 * core 响应 → BeidouToolResult。
 * message 承载给模型的文本;mock 证据 → warnings(演示数据必须显式提示);
 * evidence 直通(EvidenceRef 形状与 core EvidenceItem 兼容)。
 */
export function toBeidouResult(resp: CoreToolResponse, meta: { tool: string; traceId: string }): BeidouToolResult<Record<string, unknown>> {
  if (!resp.ok) {
    return {
      ok: false,
      code: classifyError(resp.error),
      message: resp.error ?? "unknown error",
      warnings: [],
      evidence: [],
      traceId: meta.traceId,
    };
  }
  const evidence = (resp.evidence ?? []) as unknown as EvidenceRef[];
  const warnings = evidence.some((e) => e.mock) ? ["演示数据(mock 数据源,非生产口径)"] : [];
  return {
    ok: true,
    code: "OK",
    message: resp.text,
    data: {},
    warnings,
    evidence,
    traceId: meta.traceId,
  };
}

/** dsh render:模型可见文本 = message + 警示;失败时输出 code+message(机器可判别) */
export function renderBeidouResult(_args: Record<string, unknown>, value: BeidouToolResult): Array<{ type: "text"; text: string }> {
  if (!value.ok) {
    return [{ type: "text", text: JSON.stringify({ code: value.code, message: value.message, traceId: value.traceId }) }];
  }
  const warn = value.warnings?.length ? `\n\n⚠️ ${value.warnings.join(";")}` : "";
  return [{ type: "text", text: `${value.message}${warn}` }];
}
