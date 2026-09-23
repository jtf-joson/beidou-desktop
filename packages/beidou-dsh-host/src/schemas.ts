/**
 * P1-3 协议层 · 单轨 Schema:插件内所有工具输出只有一种形状——BeidouToolResult。
 * dsh DSL 约定:output schema 全必填(可选字段用空值占位),故 data/warnings/evidence
 * 在 schema 层 required: true、运行时空时为 null/[];类型层保持契约的可选语义。
 */
import type { BeidouToolResult, EvidenceRef } from "@beidou/contracts/src/index.ts";

/** dsh defineTool 的 output schema(单轨;替代旧 {ok,text,error} 三件套) */
export const BEIDOU_RESULT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    ok: { type: "boolean" as const, required: true, description: "执行是否成功" },
    code: { type: "string" as const, required: true, description: "机器可判别结果码:OK 或 12 个错误码之一" },
    message: { type: "string" as const, required: true, description: "给模型看的结果文本;失败时为错误说明" },
    data: { type: "object" as const, required: true, description: "结构化载荷(表数据等);无则 {}", additionalProperties: true },
    warnings: { type: "array" as const, required: true, description: "降级/脱敏等警示;无则 []" },
    evidence: { type: "array" as const, required: true, description: "证据引用(EvidenceRef);无则 []" },
    traceId: { type: "string" as const, required: true, description: "全链路追踪 ID(审计/结果关联)" },
  },
};

/** 运行时产出值:可空字段以空值落盘,保证 dsh 端 schema 全必填成立 */
export type BeidouToolValue = BeidouToolResult<Record<string, unknown>>;

/**
 * 深度清洗:删除所有值为 undefined 的属性。
 * dsh 宿主 cloneJson 严格要求无损 JSON(undefined 属性值直接拒绝——"value is not
 * lossless JSON");core 的 EvidenceItem 对可选字段显式赋 undefined,JSON.stringify
 * 会静默丢弃但宿主不做 stringify 强转,故协议出口统一清洗。
 */
function pruneUndefined<T>(v: T): T {
  if (v === undefined || v === null || typeof v !== "object") return v;
  // 数组:先滤掉 undefined 元素再递归(宿主 cloneJson 对数组内的 undefined 同样拒绝)
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map((x) => pruneUndefined(x)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val !== undefined) out[k] = pruneUndefined(val);
  }
  return out as unknown as T;
}

export function toToolValue(r: BeidouToolResult<Record<string, unknown> | undefined>): BeidouToolValue {
  return pruneUndefined({
    ok: r.ok,
    code: r.code,
    message: r.message ?? "",
    data: r.data ?? {},
    warnings: r.warnings ?? [],
    evidence: (r.evidence ?? []) as EvidenceRef[],
    traceId: r.traceId,
  });
}
