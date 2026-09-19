/**
 * 北斗(AnyMetrics)导出 JSON → SemanticAssets 导入器(ARCHITECTURE 2.1)。
 * 纯函数、注入式读取;缺文件容错并记录 warning,全部缺失则产出空资产 + 全量 warning(fail-closed 不崩溃)。
 */
import type {
  ColumnBinding,
  DatasetCard,
  GlossaryTerm,
  MetricMirror,
  MetricType,
  SemanticAssets,
} from "../types";

/** 注入式文件读取:返回文件内容或 null(不存在) */
export type FileReader = (name: string) => string | null;

interface RawMetric {
  metricName?: string;
  metricDisplayName?: string;
  displayName?: string;
  type?: string;
  code?: string;
  unit?: string;
  cnUnit?: string;
  businessCaliber?: string;
  status?: string;
  owner?: string;
  businessOwner?: string;
  metricCategoryId?: string;
}

interface RawFormulaNode {
  type?: string | null;
  op?: string | null;
  args?: RawFormulaNode[] | null;
  x?: RawFormulaNode | null;
  y?: RawFormulaNode | null;
  path?: string[] | null;
}

interface RawDetail {
  code?: string;
  metricName?: string;
  type?: string;
  caliber?: {
    datasetName?: string;
    expr?: string;
    formula?: RawFormulaNode | null;
    filters?: Array<{ type?: string; expr?: string }>;
    metricTime?: string;
  };
}

interface RawDimension {
  dimName?: string;
}

interface RawLineageSummary {
  physical_table_counter?: Record<string, number>;
  physical_column_to_dataset_column?: Record<string, string[]>;
  dataset_to_physical_tables?: Record<string, string[]>;
}

interface RawPhysicalTableEntry {
  physical_tables?: string[];
  physical_columns?: string[];
  dataset_display?: string;
}

const FILES = {
  metrics: "metrics.json",
  details: "details.json",
  dimensions: "dimensions.json",
  tree: "tree.json",
  lineageSummary: "lineage_summary.json",
  physicalTables: "physical_tables.json",
} as const;

const parse = <T>(reader: FileReader, name: string, warnings: string[]): T | null => {
  const text = reader(name);
  if (text === null) {
    warnings.push(`缺少文件 ${name}`);
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    warnings.push(`文件 ${name} 解析失败:${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const asMetricType = (t?: string): MetricType =>
  t === "DERIVED" || t === "COMPOSITE" ? t : "ATOMIC";

/** 递归收集公式 AST 里引用的指标 code(NAME_REF.path 长度为 1 且以 mc 开头) */
function collectRefMetricCodes(node: RawFormulaNode | null | undefined, out: string[]): void {
  if (!node) return;
  if (node.type === "NAME_REF" && Array.isArray(node.path) && node.path.length === 1) {
    const p = node.path[0]!;
    if (/^mc/.test(p)) out.push(p);
  }
  for (const a of node.args ?? []) collectRefMetricCodes(a, out);
  collectRefMetricCodes(node.x, out);
  collectRefMetricCodes(node.y, out);
}

/** tree.json → categoryId → 类目路径(尽力而为,缺失则空) */
function buildCategoryPaths(tree: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const walk = (nodes: unknown[], path: string[]): void => {
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as Record<string, unknown>;
      const name = typeof node.categoryName === "string" ? node.categoryName : null;
      const id = typeof node.categoryId === "string" ? node.categoryId : null;
      const nextPath = name ? [...path, name] : path;
      if (id) map.set(id, nextPath);
      if (Array.isArray(node.subCategory)) walk(node.subCategory, nextPath);
    }
  };
  const root = (tree as { data?: { rootList?: unknown[] } } | null)?.data?.rootList;
  if (Array.isArray(root)) walk(root, []);
  return map;
}

export function importBeidou(reader: FileReader): SemanticAssets {
  const warnings: string[] = [];
  const metricsRaw = parse<RawMetric[]>(reader, FILES.metrics, warnings);
  const detailsRaw = parse<RawDetail[]>(reader, FILES.details, warnings);
  const dimensionsRaw = parse<Record<string, RawDimension[]>>(reader, FILES.dimensions, warnings);
  const treeRaw = parse<unknown>(reader, FILES.tree, warnings);
  const lineageRaw = parse<RawLineageSummary>(reader, FILES.lineageSummary, warnings);
  const physicalTablesRaw = parse<Record<string, RawPhysicalTableEntry>>(reader, FILES.physicalTables, warnings);

  const categoryPaths = treeRaw ? buildCategoryPaths(treeRaw) : new Map<string, string[]>();
  const detailByName = new Map<string, RawDetail>();
  for (const d of detailsRaw ?? []) {
    if (d.metricName) detailByName.set(d.metricName, d);
  }

  const datasetToTables = lineageRaw?.dataset_to_physical_tables ?? {};
  const physicalToDatasetCols = lineageRaw?.physical_column_to_dataset_column ?? {};
  const datasetDisplay = new Map<string, string>();
  for (const [metric, entry] of Object.entries(physicalTablesRaw ?? {})) {
    if (entry.dataset_display) datasetDisplay.set(metric, entry.dataset_display);
  }

  // 列绑定:物理全限定列 → 数据集列(可一对多)
  const columnBindings: ColumnBinding[] = [];
  for (const [physicalFull, datasetCols] of Object.entries(physicalToDatasetCols)) {
    const lastDot = physicalFull.lastIndexOf(".");
    if (lastDot <= 0) continue;
    const physicalTable = physicalFull.slice(0, lastDot);
    const physicalColumn = physicalFull.slice(lastDot + 1);
    for (const dc of datasetCols ?? []) {
      const dot = dc.indexOf(".");
      if (dot <= 0) continue;
      columnBindings.push({
        dataset: dc.slice(0, dot),
        datasetColumn: dc.slice(dot + 1),
        physicalTable,
        physicalColumn,
      });
    }
  }

  // 数据集列索引(数据集 → 列名集合)
  const datasetColumns = new Map<string, Set<string>>();
  for (const b of columnBindings) {
    if (!datasetColumns.has(b.dataset)) datasetColumns.set(b.dataset, new Set());
    datasetColumns.get(b.dataset)!.add(b.datasetColumn);
  }

  const metrics: MetricMirror[] = (metricsRaw ?? [])
    .filter((m) => typeof m.metricName === "string" && m.metricName.length > 0)
    .map((m) => {
      const detail = detailByName.get(m.metricName!);
      const datasetName = detail?.caliber?.datasetName;
      const physicalTables = datasetName
        ? datasetToTables[datasetName] ?? []
        : physicalTablesRaw?.[m.metricName!]?.physical_tables ?? [];
      const refCodes: string[] = [];
      collectRefMetricCodes(detail?.caliber?.formula, refCodes);
      return {
        metricName: m.metricName!,
        displayName: m.metricDisplayName ?? m.displayName ?? m.metricName!,
        type: asMetricType(m.type ?? detail?.type),
        code: m.code ?? detail?.code,
        unit: m.cnUnit ?? m.unit,
        businessCaliber: m.businessCaliber,
        status: m.status,
        owner: m.owner ?? m.businessOwner,
        categoryPath: m.metricCategoryId ? categoryPaths.get(m.metricCategoryId) ?? [] : [],
        datasetName,
        physicalTables,
        dimensions: (dimensionsRaw?.[m.metricName!] ?? [])
          .map((d) => d.dimName)
          .filter((x): x is string => typeof x === "string"),
        refMetricCodes: refCodes,
        caliber: {
          datasetName: detail?.caliber?.datasetName,
          expr: detail?.caliber?.expr,
          formula: detail?.caliber?.formula ?? undefined,
          filters: (detail?.caliber?.filters ?? []).map((f) => ({ type: f.type, expr: f.expr })),
          metricTime: detail?.caliber?.metricTime,
        },
      } satisfies MetricMirror;
    });

  // 数据集 → 指标 反向
  const datasetMetrics = new Map<string, Set<string>>();
  for (const m of metrics) {
    if (!m.datasetName) continue;
    if (!datasetMetrics.has(m.datasetName)) datasetMetrics.set(m.datasetName, new Set());
    datasetMetrics.get(m.datasetName)!.add(m.metricName);
  }

  const datasets: DatasetCard[] = Object.entries(datasetToTables).map(([name, tables]) => ({
    datasetName: name,
    displayName: datasetDisplay.get(name),
    physicalTables: tables ?? [],
    metrics: [...(datasetMetrics.get(name) ?? [])],
    columns: [...(datasetColumns.get(name) ?? [])].sort(),
  }));

  const tableToMetrics: Record<string, string[]> = {};
  for (const m of metrics) {
    for (const t of m.physicalTables) {
      (tableToMetrics[t] ??= []).push(m.metricName);
    }
  }

  const glossary: GlossaryTerm[] = [];

  return { metrics, datasets, glossary, columnBindings, tableToMetrics, importWarnings: warnings };
}
