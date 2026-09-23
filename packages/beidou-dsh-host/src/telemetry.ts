/**
 * P1-3 协议层 · 遥测:统一 AuditEventV2 事件(时长/结果码/策略裁决/traceId 关联)。
 * PoC 落点:既有 audit.jsonl(kind=tool_result,detail=V2 事件)+ 结构化控制台;
 * RemoteAuditSink(OTel)在 P1-5/Gate C 接入,此处只依赖 sink 接口。
 */
import type { AuditEventV2 } from "@beidou/contracts/src/index.ts";

export interface TelemetrySink {
  append(e: AuditEventV2): Promise<void>;
}

export function createTelemetrySink(opts: {
  sessionId: string;
  audit?: { append(e: { ts: string; kind: "tool_result"; sessionId: string; summary: string; detail?: unknown }): Promise<void> };
  log?: (line: string) => void;
}): TelemetrySink {
  return {
    async append(e) {
      const line = `[beidou-telemetry] ${e.tool} ${e.resultCode} ${e.durationMs ?? "-"}ms trace=${e.traceId}`;
      (opts.log ?? ((l: string) => console.error(l)))(line);
      // 复用 core 审计管道(写入前统一脱敏;V2 事件作为 detail 全量保留)
      await opts.audit?.append({
        ts: e.timestamp,
        kind: "tool_result",
        sessionId: opts.sessionId,
        summary: `${e.tool} → ${e.resultCode}`,
        detail: e,
      });
    },
  };
}

/** 包一层执行:计时 + 结果码 + V2 事件落遥测(成功/失败/抛错三条路径都有事件) */
export async function withTelemetry<T extends { ok: boolean; code: string }>(
  sink: TelemetrySink,
  input: {
    traceId: string;
    sessionId: string;
    tool: string;
    inputSummary: string;
    userId: string;
    policyDecision: "allow" | "ask" | "deny" | "degraded";
    resultCodeOnThrow?: AuditEventV2["resultCode"];
  },
  exec: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const emit = (resultCode: AuditEventV2["resultCode"]) =>
    sink.append({
      timestamp: new Date().toISOString(),
      traceId: input.traceId,
      sessionId: input.sessionId,
      userId: input.userId,
      tool: input.tool,
      inputSummary: input.inputSummary,
      policyDecision: input.policyDecision,
      durationMs: Date.now() - startedAt,
      resultCode,
    }).catch(() => undefined);
  let result: T;
  try {
    result = await exec();
  } catch (e) {
    await emit(input.resultCodeOnThrow ?? "INTERNAL_ERROR");
    throw e;
  }
  await emit((result.ok ? "OK" : result.code) as AuditEventV2["resultCode"]);
  return result;
}
