import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAssetWorkspace } from "./asset-repo";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

const mk = (rel: string) => mkdirSync(join(dir, rel), { recursive: true });
const put = (rel: string, content: string) => writeFileSync(join(dir, rel), content);

/** 最小五层工作区 fixture(含一条坏 YAML 验证 fail-open) */
function buildRepo(): string {
  mk("workspaces/test-ws/01-glossary/terms");
  mk("workspaces/test-ws/02-ontology/classes");
  mk("workspaces/test-ws/02-ontology/relations");
  mk("workspaces/test-ws/02-ontology/actions");
  mk("workspaces/test-ws/03-metrics/contracts");
  mk("workspaces/test-ws/04-playbooks/playbooks");
  mk("workspaces/test-ws/knowledge/pages");

  put("workspaces/test-ws/workspace.yaml", "schemaVersion: 1\nid: test-ws\nname: 测试域\n");
  put("workspaces/test-ws/active-release.yaml", "workspaceId: test-ws\nreleaseId: test-ws-2026.09.1\n");
  put("workspaces/test-ws/01-glossary/terms/nss.yaml", [
    "schemaVersion: 1", "id: term.bs.nss", "name: 净满意度", "status: published",
    "definition: 星级加权净满意度", "aliases: [NSS]", "abbreviations: [NSS]",
    "owners: [liangyingli]",
  ].join("\n"));
  put("workspaces/test-ws/01-glossary/terms/broken.yaml", "id: [未闭合\n");
  put("workspaces/test-ws/02-ontology/classes/service-ticket.yaml", [
    "schemaVersion: 1", "id: class.bs.service-ticket", "name: 服务工单", "status: published",
    "domain: domain.aftersale", "subdomain: subdomain.service", "key: ticket_id",
    "properties:",
    "  - id: property.bs.service-ticket.status",
    "    name: 工单状态",
    "    datatype: string",
  ].join("\n"));
  put("workspaces/test-ws/02-ontology/relations/at-store.yaml", [
    "schemaVersion: 1", "id: relation.bs.at-store", "name: 服务单所属门店", "status: published",
    "domain: class.bs.service-ticket", "range: class.bs.service-store", "cardinality: N:1",
  ].join("\n"));
  put("workspaces/test-ws/02-ontology/actions/diag.yaml", [
    "schemaVersion: 1", "id: action.bs.diag", "name: 诊断", "status: published",
    "subject: class.bs.service-ticket", "relatedMetrics: [metric.bs.complaint-rate]",
  ].join("\n"));
  put("workspaces/test-ws/03-metrics/contracts/complaint-rate.yaml", [
    "schemaVersion: 1", "id: metric.bs.complaint-rate", "name: 售后门店投诉率", "status: published",
    "subject: class.bs.service-ticket", "definition: 投诉工单量/总台次",
    "provider:", "  type: enterprise-metric-platform", "  providerMetricId: aftersale_store_complaint_rate",
    "owners: [liangyingli]",
    "imported:", "  metricType: COMPOSITE", "  platformStatus: ONLINE",
  ].join("\n"));
  put("workspaces/test-ws/03-metrics/contracts/derived.yaml", [
    "schemaVersion: 1", "id: metric.bs.yoy", "name: 同比", "status: deprecated",
    "derivation:", "  type: yoy", "  baseMetric: metric.bs.complaint-rate",
  ].join("\n"));
  put("workspaces/test-ws/04-playbooks/playbooks/drop.yaml", [
    "schemaVersion: 1", "id: playbook.bs.drop", "name: 投诉诊断", "status: published",
    "steps:",
    "  - id: confirm", "    name: 确认", "    rule: 投诉率超过阈值", "    metrics: [metric.bs.complaint-rate]",
  ].join("\n"));
  put("workspaces/test-ws/knowledge/pages/grading.md", "---\nid: knowledge.x\n---\n# 分级\n正文");
  return dir;
}

describe("loadAssetWorkspace", () => {
  it("装载五层工作区:元数据、术语、类、关系、动作、指标、Playbook、知识页", () => {
    dir = mkdtempSync(join(tmpdir(), "asset-repo-"));
    const root = buildRepo();
    const ws = loadAssetWorkspace(root, "test-ws");

    expect(ws.name).toBe("测试域");
    expect(ws.releaseId).toBe("test-ws-2026.09.1");
    expect(ws.terms).toHaveLength(1);
    expect(ws.terms[0]).toMatchObject({ id: "term.bs.nss", name: "净满意度", aliases: ["NSS"] });

    expect(ws.classes).toHaveLength(1);
    expect(ws.classes[0]).toMatchObject({
      id: "class.bs.service-ticket",
      key: "ticket_id",
      subdomain: "subdomain.service",
    });
    expect(ws.classes[0].properties[0]).toMatchObject({
      id: "property.bs.service-ticket.status",
      datatype: "string",
    });

    expect(ws.relations[0]).toMatchObject({ id: "relation.bs.at-store", cardinality: "N:1" });
    expect(ws.actions[0]).toMatchObject({ subject: "class.bs.service-ticket", relatedMetrics: ["metric.bs.complaint-rate"] });

    expect(ws.metrics).toHaveLength(2);
    expect(ws.metrics[0]).toMatchObject({
      id: "metric.bs.complaint-rate",
      provider: { providerMetricId: "aftersale_store_complaint_rate" },
      imported: { metricType: "COMPOSITE" },
    });
    expect(ws.metrics[1].derivation).toMatchObject({ type: "yoy", baseMetric: "metric.bs.complaint-rate" });

    expect(ws.playbooks[0]?.steps?.[0]).toMatchObject({ name: "确认", rule: "投诉率超过阈值" });
    expect(ws.knowledge[0]).toMatchObject({ name: "grading" });

    // 坏 YAML → 告警且不阻断
    expect(ws.warnings.some((w) => w.includes("broken.yaml"))).toBe(true);
  });

  it("工作区目录缺失:fail-open 空资产 + 告警", () => {
    dir = mkdtempSync(join(tmpdir(), "asset-repo-"));
    const ws = loadAssetWorkspace(dir, "nope");
    expect(ws.name).toBe("nope");
    expect(ws.releaseId).toBeNull();
    expect(ws.metrics).toEqual([]);
    expect(ws.warnings.some((w) => w.includes("不存在"))).toBe(true);
  });
});
