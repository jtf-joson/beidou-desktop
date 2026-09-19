/**
 * migrateEntities:旧 entities.yaml → 新 ontology.yaml 草稿(一次性迁移,Phase 2 执行后旧模型删除)。
 * 返回 YAML 文本 + diff 报告;草稿需人工 review 后才入库。
 */
import { stringify as toYaml } from "yaml";
import type { ParsedOntology, OntologyClass } from "./types";

export interface EntitiesLegacy {
  entities: Array<{
    name: string;
    description?: string;
    dataset?: string;
    key?: string;
    attributes: string[];
  }>;
  models: Array<{
    name: string;
    description?: string;
    entities: string[];
    metrics: string[];
    dimensions: string[];
  }>;
}

const toId = (name: string): string =>
  name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || `Class_${Date.now()}`;

export function migrateEntities(legacy: EntitiesLegacy, domainInfo: { domainId: string; domainName: string; subdomainId: string; subdomainName: string }): {
  yaml: string;
  report: string[];
} {
  const report: string[] = [];
  const classes: OntologyClass[] = legacy.entities.map((e) => {
    const id = toId(e.name);
    report.push(`entity "${e.name}" → class ${id}(subdomain=${domainInfo.subdomainId}, properties=${e.attributes.length})`);
    return {
      id,
      name: e.name,
      subdomain: domainInfo.subdomainId,
      key: e.key,
      properties: e.attributes.map((attr) => ({
        id: attr,
        name: attr,
        datatype: "string" as const,
      })),
      metrics: [],
      status: "draft" as const,
      description: e.description,
    };
  });

  // models → actions(有 metrics 的)
  const actions = legacy.models
    .filter((m) => m.metrics.length > 0)
    .map((m) => {
      const id = toId(m.name);
      report.push(`model "${m.name}" → action ${id}(metrics=${m.metrics.length}, dims=${m.dimensions.length})`);
      return {
        id: `analyze_${id}`,
        name: m.name,
        subdomain: domainInfo.subdomainId,
        subject: m.entities.length > 0 ? toId(m.entities[0]!) : classes[0]?.id ?? "Unknown",
        metrics: m.metrics,
        dims: m.dimensions.map((d) => {
          const parts = d.split("_df_");
          return parts.length === 2 ? parts[1]! : d;
        }),
        description: m.description,
      };
    });

  const ont: ParsedOntology = {
    schemaVersion: 1,
    version: "0.1.0",
    domain: {
      id: domainInfo.domainId,
      name: domainInfo.domainName,
      subdomains: [{ id: domainInfo.subdomainId, name: domainInfo.subdomainName, status: "draft", topics: ["迁移"], owners: [] }],
    },
    classes,
    relations: [],
    actions,
    warnings: [],
  };

  const yamlObj = {
    schemaVersion: ont.schemaVersion,
    version: ont.version,
    domain: ont.domain,
    classes: ont.classes,
    relations: ont.relations,
    actions: ont.actions,
  };

  return {
    yaml: `# 由 entities.yaml 迁移生成(需人工 review)\n${toYaml(yamlObj)}`,
    report,
  };
}
