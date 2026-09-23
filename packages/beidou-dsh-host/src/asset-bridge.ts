/**
 * 资产仓桥接(纯函数):五层语义资产 → beidou-core 运行时结构。
 * - assetRepoToSemanticAssets:Metric Contract → MetricMirror,术语 → GlossaryTerm
 * - assetRepoToOntology:Class/Relation/Action → ParsedOntology(list_ontology 数据源)
 * - assetRepoPlaybooks/assetRepoKnowledge:Playbook YAML 渲染为 markdown,知识页透传
 * - assetRepoSemanticVersion:releaseId ?? git sha ?? 日期(Evidence.semanticVersion)
 */
import { execSync } from "node:child_process";
import type {
  GlossaryTerm,
  MetricMirror,
  MetricCaliber,
  MetricType,
  SemanticAssets,
  ColumnBinding,
  DimensionBinding,
} from "@beidou/core/src/types.ts";
import type {
  AssetRepoWorkspace,
  AssetRepoPlaybook,
} from "@beidou/ontology-schema/src/index.ts";
import type {
  OntologyAction,
  OntologyClass,
  OntologyDomain,
  OntologyProperty,
  OntologyRelation,
  OntologyStatus,
  ParsedOntology,
} from "@beidou/ontology-schema/src/index.ts";

const METRIC_TYPES: readonly MetricType[] = ["ATOMIC", "DERIVED", "COMPOSITE"];

/** 指标类型:导入的 metricType 优先;否则按 derivation 推断;缺省 ATOMIC */
function metricType(m: AssetRepoWorkspace["metrics"][number]): MetricType {
  const imported = m.imported?.metricType;
  if (imported && (METRIC_TYPES as readonly string[]).includes(imported)) return imported as MetricType;
  if (m.derivation?.type) return "DERIVED";
  if (m.derivation?.formula) return "COMPOSITE";
  return "ATOMIC";
}

/** 平台指标名:providerMetricId 回指权威源;无 provider 时用资产 ID 本身 */
function platformMetricName(m: AssetRepoWorkspace["metrics"][number]): string {
  return m.provider?.providerMetricId ?? m.id;
}

/**
 * 五层资产 → SemanticAssets(search_semantics/query_metrics 契约数据源)。
 * deprecated 指标保留(Mirror.status 携带),由路由/展示层决定是否过滤。
 */
export function assetRepoToSemanticAssets(
  ws: AssetRepoWorkspace,
  opts?: { categoryPath?: string[] },
): SemanticAssets {
  const categoryPath = opts?.categoryPath ?? [ws.name];
  // 兼容旧版 Release Bundle：bindings 在新版本才进入快照，缺失时按空绑定处理。
  const bindings = ws.bindings ?? [];
  const tableBindings = bindings.filter((b) => b.id.startsWith("binding.table."));
  const datasetBindings = bindings.filter((b) => b.id.startsWith("dataset."));
  const metricBindings = bindings.filter((b) => b.id.startsWith("binding.metric."));
  const tableName = (b: Record<string, unknown>): string | undefined => {
    const t = b.table as Record<string, unknown> | undefined;
    if (!t || typeof t.catalog !== "string" || typeof t.schema !== "string" || typeof t.name !== "string") return undefined;
    return `${t.catalog}.${t.schema}.${t.name}`;
  };
  const datasetTables = new Map(datasetBindings.map((b) => [b.id, tableName(b)]));
  const metricById = new Map(ws.metrics.map((m) => [m.id, m]));
  const metricDataset = (m: AssetRepoWorkspace["metrics"][number]): string | undefined => {
    if (m.datasetName ?? m.caliber?.datasetName) return m.datasetName ?? m.caliber?.datasetName;
    const base = m.derivation?.baseMetric ? metricById.get(m.derivation.baseMetric) : undefined;
    return base ? metricDataset(base) : undefined;
  };
  // 派生指标(如同比/环比)可继承数据集、时间字段和固定过滤；但不能继承基础指标公式。
  // 同比/环比需要平台的周期语义，复用 sum 会把派生指标静默算错，因此运行时必须等平台查询能力。
  const metricCaliber = (
    m: AssetRepoWorkspace["metrics"][number],
    seen = new Set<string>(),
  ): NonNullable<AssetRepoWorkspace["metrics"][number]["caliber"]> | undefined => {
    if (m.caliber) return m.caliber;
    if (!m.derivation?.baseMetric || seen.has(m.id)) return undefined;
    const base = metricById.get(m.derivation.baseMetric);
    const baseCaliber = base ? metricCaliber(base, new Set([...seen, m.id])) : undefined;
    return baseCaliber ? {
      datasetName: baseCaliber.datasetName,
      metricTime: baseCaliber.metricTime,
      filters: baseCaliber.filters,
    } : undefined;
  };
  const metricTables = (m: AssetRepoWorkspace["metrics"][number]): string[] => {
    const inherited = metricDataset(m);
    return [
      ...(inherited ? [datasetTables.get(inherited)] : []),
      ...metricBindings.filter((b) => b.metricId === m.id).map(tableName),
    ].filter((x, i, all): x is string => !!x && all.indexOf(x) === i);
  };
  const metrics: MetricMirror[] = ws.metrics.map((m) => {
    const caliber = metricCaliber(m);
    const platformDimensions = m.provider?.providerMetricId
      ? ws.platformDimensions?.[m.provider.providerMetricId] ?? []
      : [];
    return {
    metricName: platformMetricName(m),
    displayName: m.name,
    type: metricType(m),
    code: m.id,
    unit: m.unit,
    businessCaliber: m.definition,
    status: m.status,
    owner: m.owners?.[0],
    categoryPath,
    // 只有指标绑定本身显式声明 table 时才建立物理口径；不能按 subject
    // 猜测维表，否则会把“销售额”错误下钻到门店维表。
    physicalTables: metricTables(m),
    dimensions: m.dimensions ?? [],
    ...(platformDimensions.length > 0 ? {
      providerDimensions: platformDimensions.map((d) => d.dimName),
      dimensionDetails: platformDimensions.map((d) => ({ name: d.dimName, displayName: d.dimDisplayName, datasetName: d.datasetName })),
    } : {}),
    refMetricCodes: m.derivation?.baseMetric ? [m.derivation.baseMetric] : [],
    datasetName: metricDataset(m),
    caliber: caliber ? {
      datasetName: caliber.datasetName ?? metricDataset(m),
      formula: caliber.formula,
      metricTime: caliber.metricTime,
      filters: caliber.filters,
    } : undefined,
    };
  });
  const datasets = datasetBindings.map((binding) => {
    const table = tableName(binding);
    const metricsForClass = ws.metrics.filter((m) => metricDataset(m) === binding.id).map(platformMetricName);
    return {
      datasetName: binding.id,
      displayName: typeof binding.name === "string" ? binding.name : binding.id,
      physicalTables: table ? [table] : [],
      metrics: metricsForClass,
      columns: Array.isArray(binding.allowedColumns) ? binding.allowedColumns.filter((x): x is string => typeof x === "string") : [],
    };
  });
  const tableDatasets = tableBindings.flatMap((binding) => {
    const table = tableName(binding);
    if (!table || typeof binding.classId !== "string") return [];
    const datasetName = binding.classId.replace(/^class\./, "dataset.");
    if (datasets.some((d) => d.datasetName === datasetName)) return [];
    return [{
      datasetName,
      displayName: typeof binding.classId === "string" ? binding.classId : datasetName,
      physicalTables: [table],
      metrics: [],
      columns: Array.isArray(binding.allowedColumns) ? binding.allowedColumns.filter((x): x is string => typeof x === "string") : [],
    }];
  });
  datasets.push(...tableDatasets);
  const columnBindings: ColumnBinding[] = datasetBindings.flatMap((binding) => {
    const table = tableName(binding);
    if (!table || !Array.isArray(binding.allowedColumns)) return [];
    return binding.allowedColumns.filter((x): x is string => typeof x === "string").map((column) => ({
      dataset: binding.id,
      datasetColumn: column,
      physicalTable: table,
      physicalColumn: column,
    }));
  });
  const dimensionBindings: DimensionBinding[] = bindings
    .filter((b) => b.id.startsWith("binding.dimension."))
    .flatMap((binding) => {
      const dim = typeof binding.dimension === "string" ? binding.dimension : undefined;
      const dimDataset = typeof binding.dimDataset === "string" ? binding.dimDataset : undefined;
      const physicalTable = tableName(binding);
      const dimColumn = typeof binding.dimColumn === "string" ? binding.dimColumn : undefined;
      if (!dim || !dimDataset || !physicalTable || !dimColumn) return [];
      return [{ dimension: dim, dimDataset, dimColumn, physicalTable, physicalColumn: typeof binding.physicalColumn === "string" ? binding.physicalColumn : dimColumn }];
    });
  const tableToMetrics: Record<string, string[]> = {};
  for (const metric of metrics) for (const table of metric.physicalTables) (tableToMetrics[table] ??= []).push(metric.metricName);
  for (const binding of metricBindings) {
    const provider = (binding.provider as Record<string, unknown> | undefined)?.providerMetricId;
    if (typeof provider === "string" && !metrics.some((m) => m.metricName === provider)) {
      // 保留未加载到的绑定作为告警，避免静默选错指标。
      ws.warnings.push(`指标绑定${binding.id}未找到对应指标:${provider}`);
    }
  }
  const glossary: GlossaryTerm[] = ws.terms.map((t) => ({
    term: t.name,
    synonyms: [...(t.aliases ?? []), ...(t.abbreviations ?? [])],
    note: t.definition,
    // 术语定义里声明的指标引用(如「口径以 metric.store.sales 为准」)→ 平台指标名,
    // 供 store 的 glossaryBoost 在别名命中时给指标加分
    metricRefs: [...(t.definition?.match(/metric\.[a-z0-9.-]+/g) ?? [])]
      .map((id) => ws.metrics.find((m) => m.id === id)?.provider?.providerMetricId)
      .filter((x): x is string => !!x),
  }));
  return {
    metrics,
    datasets,
    glossary,
    columnBindings,
    dimensionBindings,
    tableToMetrics,
    importWarnings: ws.warnings,
  };
}

const ontologyStatus = (s: string | undefined): OntologyStatus | undefined =>
  s === "published" ? "active" : s === "draft" || s === "deprecated" ? s : undefined;

/** datatype 宽容映射:资产仓 string/integer/decimal/datetime → 本体 enum */
const datatype = (d: string): OntologyProperty["datatype"] => {
  if (d === "integer" || d === "decimal" || d === "number") return "number";
  if (d === "datetime" || d === "date") return "date";
  if (d === "boolean") return "boolean";
  if (d === "enum") return "enum";
  if (d === "json") return "json";
  return "string";
};

/** 五层资产 → ParsedOntology(list_ontology/本体图数据源);Subdomain 由类声明聚合 */
export function assetRepoToOntology(ws: AssetRepoWorkspace): ParsedOntology {
  const subdomainIds = [...new Set(ws.classes.map((c) => c.subdomain).filter((s): s is string => !!s))];
  const fallbackSubdomain = `subdomain.${ws.workspaceId}`;
  const subdomains = (subdomainIds.length > 0 ? subdomainIds : [fallbackSubdomain]).map((id) => ({
    id,
    name: id.replace(/^subdomain\./, ""),
    status: "active" as const,
    topics: [],
    owners: [],
  }));
  const domain: OntologyDomain = {
    id: ws.classes[0]?.domain ?? `domain.${ws.workspaceId}`,
    name: ws.name,
    subdomains,
  };
  const classes: OntologyClass[] = ws.classes.map((c) => ({
    id: c.id,
    name: c.name,
    subdomain: c.subdomain ?? fallbackSubdomain,
    topic: c.topic,
    key: c.key,
    properties: c.properties.map((p) => ({
      id: p.id,
      name: p.name,
      datatype: datatype(p.datatype),
      required: p.required,
      description: p.dictionaryRef ? `字典:${p.dictionaryRef}` : undefined,
    })),
    status: ontologyStatus(c.status),
    description: c.description,
    owners: c.owners,
    tags: c.aliases,
  }));
  const relations: OntologyRelation[] = ws.relations.map((r) => ({
    id: r.id,
    name: r.name,
    domain: r.domain,
    range: r.range,
    cardinality: r.cardinality === "1:1" || r.cardinality === "1:N" || r.cardinality === "N:M" ? r.cardinality : undefined,
    description: r.description,
  }));
  const subjectSubdomain = new Map(ws.classes.map((c) => [c.id, c.subdomain ?? fallbackSubdomain]));
  const actions: OntologyAction[] = ws.actions.map((a) => ({
    id: a.id,
    name: a.name,
    subdomain: subjectSubdomain.get(a.subject) ?? fallbackSubdomain,
    subject: a.subject,
    metrics: a.relatedMetrics ?? [],
    playbook: a.playbooks?.[0],
  }));
  return {
    schemaVersion: 1,
    version: ws.releaseId ?? "unreleased",
    domain,
    classes,
    relations,
    actions,
    warnings: [],
  };
}

/** Playbook YAML → 人读 markdown(read_playbook 数据源) */
export function renderPlaybookMd(pb: AssetRepoPlaybook): string {
  const lines: string[] = [`# ${pb.name ?? pb.id}`, ""];
  if (pb.status) lines.push(`> 状态:${pb.status}`, "");
  if (pb.steps?.length) {
    lines.push("## 处理步骤", "");
    pb.steps.forEach((s, i) => {
      const head = `${i + 1}. **${s.name ?? s.id ?? `步骤 ${i + 1}`}**`;
      lines.push(s.rule ? `${head} —— ${s.rule}` : head);
      if (s.metrics?.length) lines.push(`   - 指标:${s.metrics.join("、")}`);
      if (s.knowledge?.length) lines.push(`   - 知识:${s.knowledge.join("、")}`);
    });
  }
  return lines.join("\n");
}

export function assetRepoPlaybooks(ws: AssetRepoWorkspace): Array<{ name: string; content: string }> {
  return ws.playbooks.map((pb) => ({ name: pb.name ?? pb.id, content: renderPlaybookMd(pb) }));
}

export function assetRepoKnowledge(ws: AssetRepoWorkspace): Array<{ name: string; content: string }> {
  return ws.knowledge.map((p) => ({ name: p.name, content: p.content }));
}

/**
 * 语义版本(方案 §9.2 Session 固定 Release):
 * releaseId(active-release.yaml)> git sha(未发布开发态)> 日期兜底。
 */
export function assetRepoSemanticVersion(ws: AssetRepoWorkspace): string {
  if (ws.releaseId) return `${ws.workspaceId}@${ws.releaseId}`;
  try {
    const sha = execSync("git rev-parse --short=8 HEAD", { cwd: ws.root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{8}$/.test(sha)) return `${ws.workspaceId}@${sha}`;
  } catch {
    // 非 git 目录(如测试 fixture)走日期兜底
  }
  return `${ws.workspaceId}@${new Date().toISOString().slice(0, 10)}`;
}
