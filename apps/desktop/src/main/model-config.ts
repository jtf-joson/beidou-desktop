/**
 * 模型配置(dsh-desktop 式设置菜单的后端)。
 * 结构化读写 config.yaml 的 model 段——渲染层永远不接触明文 key 之外的整段 YAML,
 * 也不走 config:read 的 `***` 掩码回写路径(P0-07 同类问题从这里绝缘)。
 */
import { parse, stringify } from "yaml";

export interface ModelSection {
  provider?: string;
  base_url?: string;
  auth_token?: string;
  auth_token_env?: string;
  model?: string;
}

export const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEFAULT_MODEL = "deepseek-chat";

export function readModelSection(rawYaml: string): ModelSection {
  try {
    const doc = parse(rawYaml) as Record<string, unknown> | null;
    const m = doc?.model;
    return typeof m === "object" && m !== null ? (m as ModelSection) : {};
  } catch {
    return {};
  }
}

export function resolveModelToken(m: ModelSection, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return m.auth_token ?? (m.auth_token_env ? env[m.auth_token_env] : undefined);
}

/** 合并 model 段写回;apiKey 留空 = 保持现有 key 不动 */
export function mergeModelSection(
  rawYaml: string,
  patch: { baseUrl?: string; model?: string; apiKey?: string },
): string {
  let doc: Record<string, unknown>;
  try {
    doc = (parse(rawYaml) as Record<string, unknown> | null) ?? {};
    if (typeof doc !== "object" || doc === null) doc = {};
  } catch {
    doc = {};
  }
  const cur = (typeof doc.model === "object" && doc.model !== null ? doc.model : {}) as ModelSection;
  const next: ModelSection = {
    ...cur,
    provider: cur.provider ?? "deepseek-anthropic",
  };
  if (patch.baseUrl) next.base_url = patch.baseUrl;
  if (patch.model) next.model = patch.model;
  if (patch.apiKey && patch.apiKey.trim()) next.auth_token = patch.apiKey.trim();
  doc.model = next;
  return stringify(doc);
}

/** 最小连通性测试:Anthropic 协议 /v1/messages,max_tokens=1 */
export async function testModelEndpoint(
  baseUrl: string,
  token: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.ok) return { ok: true, message: `连接成功(${resp.status},模型 ${model} 可用)` };
    const body = await resp.text().catch(() => "");
    if (resp.status === 401 || resp.status === 403) return { ok: false, message: `API Key 无效(HTTP ${resp.status})` };
    if (resp.status === 404) return { ok: false, message: "接口不存在(404)——检查 Base URL 是否为 Anthropic 兼容端点" };
    return { ok: false, message: `HTTP ${resp.status}:${body.slice(0, 200) || "(无响应体)"}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg.includes("abort") || msg.includes("timeout") ? "连接超时(20s)" : `网络错误:${msg}` };
  }
}
