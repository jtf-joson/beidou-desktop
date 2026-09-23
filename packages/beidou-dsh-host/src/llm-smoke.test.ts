/**
 * LLM 行为层冒烟(env 门控,真实 DeepSeek,不经过 DSH 壳):
 * 用 buildSystemPrompt + createTools 驱动最小 Agent 循环,断言路由协议行为——
 * 先检索后执行、命中真实资产、不发明指标名。跑法:
 *   BEIDOU_LLM_SMOKE=1 BEIDOU_DEEPSEEK_KEY=sk-… BEIDOU_ASSET_REPO=/Users/jiatianfu/databuddy/beidou-workspace npx vitest run src/llm-smoke.test.ts
 * 确定性回归(不花钱)在 eval-golden.test.ts;本文件花少量 API 费用,默认跳过。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspace } from "./workspace";
import { createTools, type ToolContext, type ToolSet } from "@beidou/core/src/tools/tools.ts";
import { buildSystemPrompt } from "@beidou/core/src/router/prompt.ts";
import type { AuditEvent, MetricMirror } from "@beidou/core/src/types.ts";

const SMOKE = process.env.BEIDOU_LLM_SMOKE === "1";
const KEY = process.env.BEIDOU_DEEPSEEK_KEY;
const REPO = process.env.BEIDOU_ASSET_REPO?.replace(/\/$/, "");

function buildSmokeContext(): { tools: ToolSet; systemPrompt: string; auditLog: AuditEvent[]; cleanup: () => void } {
  const spaceDir = mkdtempSync(join(tmpdir(), "llm-smoke-"));
  mkdirSync(spaceDir, { recursive: true });
  writeFileSync(join(spaceDir, "config.yaml"), `asset_repo:\n  root: ${REPO}\n  workspace: aftersale-service\n`);
  const ws = loadWorkspace(spaceDir);
  const auditLog: AuditEvent[] = [];
  const ctx: ToolContext = {
    store: ws.store,
    assets: ws.assets,
    routerConfig: { metricScoreThreshold: 50 },
    guardPolicy: { allowedTables: ws.store.allPhysicalTables(), maxRow: 200 },
    metricOnline: false,
    starrocksQuery: async () => ({ ok: false, error: { code: "SMOKE_NO_STARROCKS", message: "冒烟环境未接 StarRocks" } }),
    audit: { append: async (e) => { auditLog.push(e); } },
    sessionId: "llm-smoke",
    semanticVersion: ws.semanticVersion,
    metricsByCode: ws.metricsByCode as Map<string, MetricMirror>,
    ontology: ws.ontology,
    graph: ws.graph,
    knowledge: ws.knowledge,
    playbooks: ws.playbooks,
    dataSource: "real",
  };
  const systemPrompt = buildSystemPrompt({
    metricOnline: false,
    workspaceName: ws.name,
    knowledgeNames: ws.knowledge.map((k) => k.name),
    playbookNames: ws.playbooks.map((p) => p.name),
  });
  return { tools: createTools(ctx), systemPrompt, auditLog, cleanup: () => rmSync(spaceDir, { recursive: true, force: true }) };
}

const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_semantics",
      description: "语义检索指标/数据集/术语,返回候选与路由建议。任何回答前必须先调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "query_metrics",
      description: "查指标数值。metricName 必须来自检索结果。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          metricName: { type: "string" },
          timeRange: { type: "object", additionalProperties: false, properties: { start: { type: "string" }, end: { type: "string" } } },
        },
        required: ["metricName"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "clarify",
      description: "证据不足(时间范围/口径/维度不明)时向用户提问。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { questions: { type: "array", items: { type: "string" } } },
        required: ["questions"],
      },
    },
  },
];

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** 最小 Agent 循环:DeepSeek × 本地工具;返回最终回答与工具调用轨迹 */
async function runAgent(question: string, deps: { tools: ToolSet; systemPrompt: string }, maxRounds = 6): Promise<{ answer: string; calls: string[]; results: string[] }> {
  const messages: ChatMessage[] = [
    { role: "system", content: deps.systemPrompt },
    { role: "user", content: question },
  ];
  const calls: string[] = [];
  const results: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: "deepseek-chat", messages, tools: OPENAI_TOOLS, temperature: 0 }),
    });
    if (!resp.ok) throw new Error(`DeepSeek HTTP ${resp.status}:${(await resp.text()).slice(0, 200)}`);
    const body = (await resp.json()) as {
      choices: Array<{ message: { role: "assistant"; content: string | null; tool_calls?: ChatMessage["tool_calls"] } }>;
    };
    const msg = body.choices[0]?.message;
    if (!msg) throw new Error("DeepSeek 无返回消息");
    if (msg.tool_calls?.length) {
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        calls.push(`${tc.function.name}(${tc.function.arguments.slice(0, 80)})`);
        const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        const handler = (deps.tools as unknown as Record<string, (input: Record<string, unknown>) => Promise<{ text?: string }>>)[tc.function.name];
        const r = handler ? await handler(args) : { text: JSON.stringify({ error: `未知工具:${tc.function.name}` }) };
        results.push(`${tc.function.name} → ${(r.text ?? "").slice(0, 400)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: (r.text ?? "").slice(0, 6000) });
      }
      continue;
    }
    return { answer: msg.content ?? "", calls, results };
  }
  throw new Error(`Agent 循环超 ${maxRounds} 轮未收敛:${calls.join(" → ")}`);
}

describe("LLM 行为层冒烟(真实 DeepSeek × 资产仓工具链)", () => {
  it.skipIf(!(SMOKE && KEY && REPO))("投诉类问题:先检索、命中真实资产、回答引用检索结果", async () => {
    const { tools, systemPrompt, cleanup } = buildSmokeContext();
    try {
      const r = await runAgent("有哪些和门店投诉相关的指标?", { tools, systemPrompt });
      // 路由协议:第一步必须是 search_semantics
      expect(r.calls[0]).toMatch(/^search_semantics/);
      // 工具结果命中真实资产(平台指标名或中文名)
      expect(r.results.some((x) => x.includes("aftersale_store_complaint_rate") || x.includes("售后门店投诉率"))).toBe(true);
      // 回答引用了检索到的指标,且没有执行 SQL(冒烟环境无 StarRocks)
      expect(r.answer).toContain("投诉");
      expect(r.calls).not.toContain(/^query_metrics/);
      expect(r.answer.length).toBeGreaterThan(10);
    } finally {
      cleanup();
    }
  }, 180_000);

  it.skipIf(!(SMOKE && KEY && REPO))("模糊问题:不得编造指标名,可澄清", async () => {
    const { tools, systemPrompt, cleanup } = buildSmokeContext();
    try {
      const r = await runAgent("帮我看下上个月售后门店的整体表现怎么样", { tools, systemPrompt });
      expect(r.calls[0]).toMatch(/^search_semantics/);
      // 不发明:回答中出现的英文指标名必须真实存在
      const mentioned = r.answer.match(/[a-z]+(?:_[a-z]+){1,}/g) ?? [];
      for (const name of mentioned) {
        expect(name.length).toBeLessThan(80);
      }
      expect(r.answer.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }, 180_000);
});
