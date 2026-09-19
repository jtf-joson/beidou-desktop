/**
 * 空间资产隔离:SpaceScope → SemanticAssets 过滤(ARCHITECTURE「空间=目录+scope」)。
 * 隔离层次:① 文件层(每空间独立 workspace 目录);② 资产层(本模块过滤语义资产);
 * ③ 查询层(guard 白名单从过滤后的 store 派生,物理上查不到范围外的表)。
 * scope 是「包含过滤器」:多条件并集;null = 不过滤(空间即导入全集)。
 */
import { ok, err, type Result, type SemanticAssets } from "../types";
import { parse as parseYaml } from "yaml";

export interface SpaceScope {
  /** 指标名白名单 */
  metricNames?: string[];
  /** 类目前缀(如 [["智能驾驶"], ["智能空间","蓝牙钥匙"]]) */
  categoryPaths?: string[][];
  /** 数据集白名单 */
  datasets?: string[];
  /** 物理表白名单(额外包含) */
  tables?: string[];
}

export function parseScope(text: string): Result<SpaceScope | null> {
  if (!text.trim()) return ok(null);
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    return err("SCOPE_PARSE", `scope.yaml 解析失败:${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") return ok(null);
  const raw = parsed as Record<string, unknown>;
  const scope: SpaceScope = {};
  if (Array.isArray(raw.metricNames)) scope.metricNames = raw.metricNames.filter((x): x is string => typeof x === "string");
  if (Array.isArray(raw.datasets)) scope.datasets = raw.datasets.filter((x): x is string => typeof x === "string");
  if (Array.isArray(raw.tables)) scope.tables = raw.tables.filter((x): x is string => typeof x === "string");
  if (Array.isArray(raw.categoryPaths)) {
    scope.categoryPaths = raw.categoryPaths
      .map((p) => (Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : null))
      .filter((p): p is string[] => p !== null && p.length > 0);
  }
  if (Object.keys(scope).length === 0) return ok(null);
  return ok(scope);
}

const matchCategory = (path: string[], prefix: string[]): boolean =>
  prefix.length <= path.length && prefix.every((seg, i) => path[i] === seg);

export function filterAssets(assets: SemanticAssets, scope: SpaceScope | null): SemanticAssets {
  if (!scope) return assets;
  const { metricNames = [], categoryPaths = [], datasets = [], tables = [] } = scope;
  const metricSet = new Set(metricNames);
  const dsSet = new Set(datasets);

  const keptMetrics = assets.metrics.filter((m) => {
    if (metricSet.has(m.metricName)) return true;
    if (m.datasetName && dsSet.has(m.datasetName)) return true;
    if (categoryPaths.some((p) => matchCategory(m.categoryPath, p))) return true;
    return false;
  });
  const keptMetricNames = new Set(keptMetrics.map((m) => m.metricName));

  // 数据集:被保留指标引用的 ∪ 显式声明的
  const keptDsNames = new Set<string>([
    ...keptMetrics.map((m) => m.datasetName).filter((d): d is string => Boolean(d)),
    ...datasets,
  ]);
  const keptDatasets = assets.datasets.filter((d) => keptDsNames.has(d.datasetName));

  // 列绑定与反向索引按保留数据集重建;显式 tables 额外保留(空表也保留)
  const keptBindings = assets.columnBindings.filter((b) => keptDsNames.has(b.dataset));
  const tableToMetrics: Record<string, string[]> = {};
  for (const m of keptMetrics) {
    for (const t of m.physicalTables) {
      (tableToMetrics[t] ??= []).push(m.metricName);
    }
  }
  for (const t of tables) if (!tableToMetrics[t]) tableToMetrics[t] = [];

  const keptGlossary = assets.glossary.filter((g) => {
    const refs = g.metricRefs ?? [];
    if (refs.length === 0) return true;
    return refs.some((r) => keptMetricNames.has(r));
  });

  return {
    metrics: keptMetrics,
    datasets: keptDatasets,
    glossary: keptGlossary,
    columnBindings: keptBindings,
    tableToMetrics,
    importWarnings: assets.importWarnings,
  };
}
