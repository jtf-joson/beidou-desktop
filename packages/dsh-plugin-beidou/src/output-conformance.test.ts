/**
 * 协议出口符合性(Phase A spike 实证发现的 bug 的常驻门禁):
 * dsh 宿主 cloneJson 拒绝任何 undefined 属性值("value is not lossless JSON"),
 * core EvidenceItem 显式赋 undefined 的可选字段曾全量炸掉工具输出。
 * toToolValue 的 pruneUndefined 必须清洗掉所有 undefined。
 */
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { BEIDOU_RESULT_SCHEMA, toToolValue } from "./schemas";
import { toBeidouResult } from "./adapter";
import { buildPluginContext } from "./context";
import { createTools } from "@beidou-core/tools/tools";
import { homedir } from "node:os";
import { join } from "node:path";

function scanUndefined(v: unknown, path = "$", out: string[] = []): string[] {
  if (v === undefined) { out.push(path); return out; }
  if (v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) { v.forEach((x, i) => scanUndefined(x, `${path}[${i}]`, out)); return out; }
  for (const [k, val] of Object.entries(v)) scanUndefined(val, `${path}.${k}`, out);
  return out;
}

describe("工具输出协议出口符合性(真实 workspace)", () => {
  it("全部业务工具输出:无 undefined 值 + 通过 BEIDOU_RESULT_SCHEMA 校验", async () => {
    const built = await buildPluginContext({ workspace: join(homedir(), "Library/Application Support/北斗work/workspace") });
    const tools = createTools({
      store: built.workspace.store, assets: built.workspace.assets,
      routerConfig: { metricScoreThreshold: 50 }, guardPolicy: built.toolContextOverrides.guardPolicy,
      metricOnline: false, starrocksQuery: built.toolContextOverrides.starrocksQuery,
      audit: built.toolContextOverrides.auditSink, sessionId: "t",
      semanticVersion: built.workspace.semanticVersion, metricsByCode: built.workspace.metricsByCode,
      knowledge: built.workspace.knowledge, playbooks: built.workspace.playbooks,
      entities: built.workspace.entities, ontology: built.workspace.ontology,
      bindings: built.workspace.bindings, dataSource: built.toolContextOverrides.dataSource,
    } as never);
    const cases: Array<[string, () => Promise<{ ok: boolean; text: string; evidence?: unknown[] }>]> = [
      ["search_semantics", () => tools.search_semantics({ query: "高速智驾天数" })],
      ["clarify", () => tools.clarify({ questions: ["时间范围?"] })],
      ["search_knowledge", () => tools.search_knowledge({ query: "口径" })],
      ["read_playbook", () => tools.read_playbook({ name: "指标异动归因" })],
    ];
    for (const [name, fn] of cases) {
      const resp = await fn();
      const value = toToolValue(toBeidouResult(resp, { tool: name, traceId: "btr-t" }));
      const undefs = scanUndefined(value);
      expect(undefs, `${name} 清洗后仍残留 undefined:${undefs.slice(0, 5).join(",")}`).toEqual([]);
      expect(() => validateJsonSchemaValue(BEIDOU_RESULT_SCHEMA as never, value as never), `${name} schema 校验`).not.toThrow();
    }
  });
});
