/**
 * adapter:P1-3 协议单轨的唯一边界——core ToolResponse → BeidouToolResult。
 * 旧 {ok,text,error} 双轨废止:插件内一切工具输出只有 BeidouToolResult 一种形状。
 */
import type { BeidouToolResult, EvidenceRef } from "@beidou/contracts/src/index.ts";
import { randomUUID } from "node:crypto";
import { classifyError } from "./errors";

/** core 工具返回的结构性子集(与 beidou-core ToolResponse 兼容;evidence 为核心侧 EvidenceItem[]) */
export interface CoreToolResponse {
  ok: boolean;
  text: string;
  evidence?: unknown[];
  error?: string;
}

function parsePayload(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** 将核心工具的结构化 JSON 转为工作台可直接渲染的结果集合。 */
export function buildAnalysisResults(payload: Record<string, unknown>, tool: string, traceId: string, sourceEvidence: unknown[] = []): Record<string, unknown>[] {
  const evidence = [{ traceId, ...sourceEvidence.map((item) => {
    if (!item || typeof item !== "object") return {}
    const value = item as Record<string, unknown>
    return {
      source: value.source,
      caliber: value.caliber,
      sql: value.sql,
      physicalTables: value.physicalTables,
      semanticVersion: value.semanticVersion,
      rows: value.rows,
      truncated: value.truncated,
      mock: value.mock,
    }
  }).find((item) => Object.values(item).some((value) => value !== undefined)) }]
  if (tool === "diagnose_metric") {
    const anomaly = payload.anomaly as { anomaly?: boolean; deltaPct?: number } | undefined
    const totals = payload.totals as { current?: unknown; prior?: unknown; delta?: unknown } | undefined
    const attributions = Array.isArray(payload.attributions) ? payload.attributions : []
    const diagnosis = {
      type: "diagnosis",
      title: `指标诊断 · ${String(payload.metric ?? "")}`,
      severity: anomaly?.anomaly ? "warning" : "info",
      description: anomaly?.deltaPct === undefined ? "已完成指标诊断" : `变化 ${anomaly.deltaPct}%`,
      findings: [{ title: "总体变化", detail: JSON.stringify(totals ?? {}) }, ...attributions.slice(0, 5).map((item) => ({ title: "维度贡献", detail: JSON.stringify(item) }))],
      evidence,
      actions: ["explain", "drilldown", "lineage", "report"],
    }
    const charts = attributions.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const attribution = item as { dim?: unknown; top?: unknown }
      const top = Array.isArray(attribution.top) ? attribution.top : []
      const points = top.filter((point): point is Record<string, unknown> => !!point && typeof point === "object")
      if (!points.length) return []
      return [{
        type: "bar",
        title: `维度贡献 · ${String(attribution.dim ?? "")}`,
        description: "贡献值 = (本期维度值 - 基期维度值) / 基期总量，正值推动上升，负值推动下降。",
        labels: points.map((point) => String(point.value ?? "null")),
        series: [{ name: "贡献率", values: points.map((point) => Number(point.contribution ?? 0) * 100) }],
        evidence,
      }]
    })
    return [diagnosis, ...charts]
  }
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  const columns = Array.isArray(payload.columns) ? payload.columns : rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0] as object) : []
  if (rows.length > 0 || columns.length > 0) {
    return [{
      type: "table",
      title: tool === "query_metrics" ? `指标结果 · ${String(payload.metric ?? "")}` : "数据查询结果",
      columns: columns.map((key) => ({ key: String(key), label: String(key) })),
      rows,
      truncated: payload.truncated === true,
      evidence,
      actions: ["drilldown", "explain", "lineage", "sql", "export"],
    }]
  }
  return []
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
    data: { ...parsePayload(resp.text), analysisResults: buildAnalysisResults(parsePayload(resp.text), meta.tool, meta.traceId, resp.evidence ?? []) },
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
