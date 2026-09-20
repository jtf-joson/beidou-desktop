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

/** 合并结果:原 YAML 损坏时 fail-closed 拒绝保存(审核六轮 P0-02,
 * 旧实现 catch 后 doc={} 会把 starrocks/auth 等段整体清空) */
export type MergeResult = { ok: true; value: string } | { ok: false; error: string };

/** 合并 model 段写回;apiKey 留空 = 保持现有 key 不动;原 YAML 解析失败 = 拒绝 */
export function mergeModelSection(
  rawYaml: string,
  patch: { baseUrl?: string; model?: string; apiKey?: string },
): MergeResult {
  let doc: Record<string, unknown>;
  if (rawYaml.trim() === "") {
    doc = {}; // 空文件 = 首次配置,允许从骨架起步
  } else {
    let parsed: unknown;
    try {
      parsed = parse(rawYaml);
    } catch (e) {
      return {
        ok: false,
        error: `config.yaml 已损坏(${e instanceof Error ? e.message.split("\n")[0] : String(e)}),已拒绝保存——请先人工修复该文件,否则保存会把其他配置段清空`,
      };
    }
    if (parsed === null || parsed === undefined) {
      doc = {};
    } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "config.yaml 根节点不是 YAML 映射,已拒绝保存(防止清空其他配置段)" };
    } else {
      doc = parsed as Record<string, unknown>;
    }
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
  return { ok: true, value: stringify(doc) };
}

/** 配置原子写:tmp → rename;写前备份 .bak(半写损坏的最后防线) */
export async function writeConfigAtomic(configPath: string, content: string): Promise<void> {
  const { writeFile, rename, copyFile } = await import("node:fs/promises");
  await copyFile(configPath, `${configPath}.bak`).catch(() => undefined); // 首次保存无原文件
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, content, "utf-8");
  try {
    await rename(tmp, configPath);
  } catch (e) {
    await import("node:fs/promises").then((fs) => fs.unlink(tmp).catch(() => undefined));
    throw new Error(`配置写入失败:${e instanceof Error ? e.message : String(e)}`);
  }
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
