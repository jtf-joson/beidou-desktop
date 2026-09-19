/**
 * 真实 LLM 冒烟(手动):DATA_AGENT_LLM_SMOKE=1 DEEPSEEK_API_KEY=... npx vitest run tests/manual/llm-smoke.test.ts
 * 验证链路:Claude Agent SDK(spawn CLI)→ DeepSeek Anthropic 端点 → 进程内 MCP 四工具 → 口径编译 → fake StarRocks。
 * 不连真实 StarRocks(查询层用 fake),模型调用是真实的。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspace } from "../../src/main/workspace";
import { AgentService, type AgentEvent } from "../../src/main/agent/service";
import { runSdkAgent } from "../../src/main/agent/sdk-runner";
import type { SrQueryResult } from "@beidou/core/src/services/starrocks";

const RUN = process.env.DATA_AGENT_LLM_SMOKE === "1";
const FIXTURE_DIR = fileURLToPath(new URL("../../../packages/beidou-core/test-fixtures/beidou", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe.skipIf(!RUN)("LLM 冒烟(DeepSeek + Agent SDK + MCP 工具,真实模型调用)", () => {
  it("问指标 → LLM 驱动检索/路由/编译 → 带证据回答", { timeout: 240_000 }, async () => {
    const key = process.env.DEEPSEEK_API_KEY ?? "";
    expect(key.startsWith("sk-")).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "daw-llm-"));
    mkdirSync(join(dir, "semantics", "import"), { recursive: true });
    const MAP: Record<string, string> = {
      "metrics.json": "metrics.sample.json",
      "details.json": "details.sample.json",
      "dimensions.json": "dimensions.sample.json",
      "lineage_summary.json": "lineage_summary.sample.json",
      "physical_tables.json": "physical_tables.sample.json",
    };
    for (const [canonical, fixture] of Object.entries(MAP)) {
      cpSync(join(FIXTURE_DIR, fixture), join(dir, "semantics", "import", canonical));
    }
    mkdirSync(join(dir, ".claude", "skills", "metric-qa"), { recursive: true });
    cpSync(join(APP_ROOT, "resources/workspace-default/skills/metric-qa/SKILL.md"), join(dir, ".claude", "skills", "metric-qa", "SKILL.md"));
    writeFileSync(
      join(dir, "config.yaml"),
      [
        "name: LLM冒烟",
        "model:",
        "  base_url: https://api.deepseek.com/anthropic",
        `  auth_token: ${key}`,
        "  model: deepseek-flash[1m]",
        "guard:",
        "  max_row: 100",
        "  sensitive_columns: []",
        "",
      ].join("\n"),
    );

    const ws = loadWorkspace(dir);
    expect(ws.assets.metrics.length).toBeGreaterThan(0);

    const rows: SrQueryResult = { rows: [{ metric_value: 42 }], columns: ["metric_value"], rowCount: 1, truncated: false };
    const service = new AgentService(ws, {
      starrocksQuery: async () => ({ ok: true, value: rows }),
      runSdkAgent,
    });
    expect(service.useSdk).toBe(true);

    const events: AgentEvent[] = [];
    await service.ask("llm-smoke", "高速智驾天数最近一个月是多少?", (e) => events.push(e));

    const tools = events
      .filter((e) => e.type === "tool")
      .map((e) => (e as { name: string }).name.replace(/^mcp__data-workbench__/, ""));
    const finalText = events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text).join("\n");
    const toolResults = events.filter((e) => e.type === "tool_result").map((e) => `${(e as { name: string }).name.replace(/^mcp__data-workbench__/, "")}:${(e as { summary: string }).summary}`);
    console.log("[llm-smoke] tools:", tools.join(" → "));
    console.log("[llm-smoke] tool_results:", toolResults.join(" | "));
    console.log("[llm-smoke] final:", finalText.slice(0, 600));
    console.log("[llm-smoke] events:", events.map((e) => `${e.type}${"text" in e && e.text ? ":" + e.text.slice(0, 50).replace(/\n/g, " ") : ""}${"name" in e && e.name ? ":" + e.name : ""}`).join(" || "));

    expect(tools).toContain("search_semantics");
    expect(tools).toContain("query_metrics");
    expect(finalText.length).toBeGreaterThan(10);
    const ev = events.find((e) => e.type === "evidence") as { items: Array<{ kind: string; caliber?: unknown }> } | undefined;
    expect(ev?.items.some((i) => i.kind === "metric_query")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });
});
