import { describe, expect, it } from "vitest";
import {
  assetRepoToOntology,
  assetRepoToSemanticAssets,
  assetRepoSemanticVersion,
  renderPlaybookMd,
} from "./asset-bridge";
import { FixtureWs } from "./asset-bridge.test-utils";
import type { AssetRepoWorkspace } from "@beidou/ontology-schema/src/index.ts";
import { loadAssetWorkspace } from "@beidou/ontology-schema/src/index.ts";
import { resolve } from "node:path";

const ws: AssetRepoWorkspace = { ...FixtureWs };

describe("assetRepoToSemanticAssets", () => {
  const assets = assetRepoToSemanticAssets(ws);

  it("loads the real aftersale-service metric assets", () => {
    const repoRoot = process.env.BEIDOU_ASSET_REPO ?? resolve(process.cwd(), "../../..", "beidou-workspace");
    const repo = loadAssetWorkspace(repoRoot, "aftersale-service");
    const mapped = assetRepoToSemanticAssets(repo);
    expect(mapped.metrics).toHaveLength(369);
    expect(mapped.metrics.find((m) => m.metricName === "aftersale_store_cnt")).toMatchObject({
      code: "metric.bs.aftersale-store-cnt",
      metricName: "aftersale_store_cnt",
      providerDimensions: [
        "repair_store_city_code",
        "repair_store_province_name",
        "repair_supervisor_dept_code",
        "repair_supervisor_dept_name",
        "repair_store_city_name",
        "repair_store_province_code",
        "repair_store_type_id",
        "city_type_name",
        "repair_store_type_name",
        "metric_time",
      ],
    });
    expect(mapped.metrics.every((m) => m.metricName && m.code)).toBe(true);
    expect(mapped.metrics.filter((m) => (m.providerDimensions?.length ?? 0) > 0)).toHaveLength(369);
  });

  it("指标契约 → MetricMirror:平台名、类型映射、code=资产 ID、口径", () => {
    const m = assets.metrics.find((x) => x.metricName === "aftersale_store_complaint_rate");
    expect(m).toMatchObject({
      displayName: "售后门店投诉率",
      type: "COMPOSITE", // imported.metricType 优先
      code: "metric.bs.complaint-rate",
      businessCaliber: "投诉工单量/总台次",
      status: "published",
      owner: "liangyingli",
    });
  });

  it("类型推断回退:derivation.type → DERIVED,formula → COMPOSITE,缺省 ATOMIC", () => {
    const byCode = new Map(assets.metrics.map((m) => [m.code, m]));
    expect(byCode.get("metric.bs.yoy")?.type).toBe("DERIVED");
    expect(byCode.get("metric.bs.avg")?.type).toBe("COMPOSITE");
    expect(byCode.get("metric.bs.plain")?.type).toBe("ATOMIC");
    // 无 providerMetricId 时用资产 ID
    expect(byCode.get("metric.bs.yoy")?.metricName).toBe("metric.bs.yoy");
  });

  it("术语 → GlossaryTerm:别名 + 缩写合并;deprecated 指标保留", () => {
    expect(assets.glossary[0]).toMatchObject({ term: "净满意度", synonyms: ["NSS", "用户净满意度"] });
    expect(assets.metrics.some((m) => m.status === "deprecated")).toBe(true);
    expect(assets.datasets).toEqual([]);
  });
});

describe("assetRepoToOntology", () => {
  const ont = assetRepoToOntology(ws);

  it("类 → OntologyClass:datatype 宽容映射、status 映射、子域聚合", () => {
    const c = ont.classes.find((x) => x.id === "class.bs.service-ticket");
    expect(c?.subdomain).toBe("subdomain.service");
    expect(c?.properties.map((p) => p.datatype)).toEqual(["string", "number", "date"]);
    expect(ont.domain.subdomains.map((s) => s.id)).toContain("subdomain.service");
    expect(ont.version).toBe("rel-1");
  });

  it("关系 cardinality 白名单(N:1 不映射);action 挂 subject 子域", () => {
    expect(ont.relations.find((r) => r.id === "relation.bs.at-store")?.cardinality).toBeUndefined();
    expect(ont.relations.find((r) => r.id === "relation.bs.serves")?.cardinality).toBe("1:N");
    expect(ont.actions[0]).toMatchObject({ subject: "class.bs.service-ticket", subdomain: "subdomain.service" });
  });
});

describe("playbook 渲染与语义版本", () => {
  it("Playbook YAML → markdown 步骤", () => {
    const md = renderPlaybookMd(ws.playbooks[0]);
    expect(md).toContain("# 投诉诊断");
    expect(md).toContain("1. **确认** —— 投诉率超过阈值");
    expect(md).toContain("指标:metric.bs.complaint-rate");
  });

  it("语义版本:releaseId 优先;无 git 时日期兜底", () => {
    expect(assetRepoSemanticVersion(ws)).toBe("test-ws@rel-1");
    expect(assetRepoSemanticVersion({ ...ws, releaseId: null })).toMatch(/^test-ws@\d{4}-\d{2}-\d{2}$/);
  });
});
