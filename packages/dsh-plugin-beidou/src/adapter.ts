/**
 * adapter:把 core ToolResponse → dsh defineTool 的 output(schema + render)。
 * 统一包装,处理 ok/error 分支与证据展示。
 */


export interface AdapterSchema {
  type: "object";
  additionalProperties: false;
  properties: Record<string, { type: "string" | "number" | "boolean" | "array" | "object"; required: boolean; description?: string }>;
}

/** 所有业务工具的统一 output schema(ok/text/evidence/warning) */
export const TOOL_OUTPUT_SCHEMA: AdapterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    text: { type: "string", required: true },
    error: { type: "string", required: false },
  },
};

export function renderToolResponse(_args: Record<string, unknown>, value: { ok: boolean; text: string; error?: string }) {
  return [{ type: "text" as const, text: value.ok ? value.text : JSON.stringify({ error: value.error ?? "unknown" }) }];
}

/** 把 ToolResponse 包装为 defineTool 的 output 值 */
export function toToolValue(resp: { ok: boolean; text: string; error?: string }): { ok: boolean; text: string; error?: string } {
  return { ok: resp.ok, text: resp.text, error: resp.error };
}
