/** asset-bridge 测试共用 fixture(与资产仓 YAML 形状一致的最小对象) */
import type { AssetRepoWorkspace } from "@beidou/ontology-schema/src/index.ts";

export const FixtureWs: AssetRepoWorkspace = {
  root: "/nonexistent",
  workspaceId: "test-ws",
  name: "测试域",
  releaseId: "rel-1",
  terms: [
    {
      id: "term.bs.nss",
      name: "净满意度",
      status: "published",
      definition: "星级加权净满意度",
      aliases: ["NSS"],
      abbreviations: ["用户净满意度"],
      owners: ["liangyingli"],
    },
  ],
  classes: [
    {
      id: "class.bs.service-ticket",
      name: "服务工单",
      status: "published",
      domain: "domain.aftersale",
      subdomain: "subdomain.service",
      key: "ticket_id",
      properties: [
        { id: "property.bs.service-ticket.status", datatype: "string" },
        { id: "property.bs.service-ticket.amount", datatype: "decimal" },
        { id: "property.bs.service-ticket.paid-at", datatype: "datetime" },
      ],
    },
  ],
  relations: [
    { id: "relation.bs.at-store", name: "服务单所属门店", status: "published", domain: "class.bs.service-ticket", range: "class.bs.service-store", cardinality: "N:1" },
    { id: "relation.bs.serves", name: "门店服务客户", status: "published", domain: "class.bs.service-ticket", range: "class.bs.customer", cardinality: "1:N" },
  ],
  actions: [
    { id: "action.bs.diag", name: "诊断", status: "published", subject: "class.bs.service-ticket", relatedMetrics: ["metric.bs.complaint-rate"] },
  ],
  metrics: [
    {
      id: "metric.bs.complaint-rate",
      name: "售后门店投诉率",
      status: "published",
      definition: "投诉工单量/总台次",
      subject: "class.bs.service-ticket",
      provider: { type: "enterprise-metric-platform", providerMetricId: "aftersale_store_complaint_rate" },
      owners: ["liangyingli"],
      imported: { metricType: "COMPOSITE", platformStatus: "ONLINE" },
    },
    { id: "metric.bs.yoy", name: "投诉率同比", status: "deprecated", derivation: { type: "yoy", baseMetric: "metric.bs.complaint-rate" } },
    { id: "metric.bs.avg", name: "单产", status: "published", derivation: { formula: "a/b" } },
    { id: "metric.bs.plain", name: "台次", status: "published" },
  ],
  playbooks: [
    {
      id: "playbook.bs.drop",
      name: "投诉诊断",
      status: "published",
      steps: [{ id: "confirm", name: "确认", rule: "投诉率超过阈值", metrics: ["metric.bs.complaint-rate"] }],
    },
  ],
  knowledge: [{ name: "grading", content: "# 分级\n正文" }],
  bindings: [],
  platformDimensions: {},
  warnings: [],
};
