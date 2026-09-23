import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginContext } from "./context";
import { createTools } from "@beidou/core/src/tools/tools.ts";

const repo = process.env.BEIDOU_ASSET_REPO;

describe("售后服务域真实资产智能分析闭环", () => {
  it.skipIf(!repo)("语义检索 → 在线指标路由 → 结构化结果", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beidou-real-analysis-"));
    try {
      writeFileSync(join(dir, "config.yaml"), `asset_repo:\n  root: ${repo}\n  workspace: aftersale-service\n`);
      const built = await buildPluginContext({ workspace: dir });
      const audit = built.toolContextOverrides.auditSink;
      const onlineDims: string[][] = [];
      const tools = createTools({
        store: built.workspace.store,
        assets: built.workspace.assets,
        ontology: built.workspace.ontology,
        graph: built.workspace.graph,
        entities: built.workspace.entities,
        bindings: built.workspace.bindings,
        knowledge: built.workspace.knowledge,
        playbooks: built.workspace.playbooks,
        metricsByCode: built.workspace.metricsByCode,
        routerConfig: { metricScoreThreshold: 50 },
        guardPolicy: built.toolContextOverrides.guardPolicy,
        metricOnline: true,
        queryMetricsOnline: async ({ metricName, dims }) => {
          if (metricName === "aftersale_store_cnt") onlineDims.push(dims ?? []);
          return { ok: true as const, value: { rows: [{ metricName, metric_time: "2026-01", value: 12 }], note: "test online result" } };
        },
        starrocksQuery: built.toolContextOverrides.starrocksQuery,
        audit,
        sessionId: "real-asset-test",
        semanticVersion: built.workspace.semanticVersion,
        dataSource: built.toolContextOverrides.dataSource,
      });
      const search = await tools.search_semantics({ query: "售后门店数量" });
      expect(search.ok).toBe(true);
      expect(search.text).toContain("aftersale_store_cnt");
      const query = await tools.query_metrics({ metricName: "aftersale_store_cnt", dims: ["dimension.bs.metric-time"] });
      expect(query.ok).toBe(true);
      expect(query.text).toContain("2026-01");
      expect(onlineDims).toEqual([["metric_time"]]);
      expect(query.evidence[0]?.semanticVersion).toBe(built.workspace.semanticVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
