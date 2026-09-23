import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { compileAssetBundle, loadAssetBundle, writeAssetBundle } from "../packages/beidou-dsh-host/src/asset-bundle.ts";

const args = new Set(process.argv.slice(2));
const value = (name: string, fallback: string): string => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
};

const repoRoot = resolve(value("repo", process.env.BEIDOU_ASSET_REPO ?? "../beidou-workspace"));
const workspaceId = value("workspace", "aftersale-service");
const outDir = resolve(value("out", `build/asset-bundles/${workspaceId}`));

function assertAnalysisReady(bundle: ReturnType<typeof compileAssetBundle>): void {
  const errors: string[] = [];
  const bindings = bundle.workspace.bindings ?? [];
  const datasets = new Map(bindings.filter((b) => b.id.startsWith("dataset.")).map((b) => [b.id, b]));
  const metrics = new Map(bundle.workspace.metrics.map((m) => [m.id, m]));
  const resolveMetric = (metric: typeof bundle.workspace.metrics[number], seen = new Set<string>()): typeof metric => {
    if (metric.caliber?.formula || !metric.derivation?.baseMetric || seen.has(metric.id)) return metric;
    const base = metrics.get(metric.derivation.baseMetric);
    if (!base) return metric;
    const resolved = resolveMetric(base, new Set([...seen, metric.id]));
    return {
      ...metric,
      datasetName: metric.datasetName ?? resolved.datasetName,
      caliber: metric.caliber ?? resolved.caliber,
    };
  };
  const tableOf = (b: Record<string, unknown>): string | undefined => {
    const t = b.table as Record<string, unknown> | undefined;
    return t && typeof t.catalog === "string" && typeof t.schema === "string" && typeof t.name === "string"
      ? `${t.catalog}.${t.schema}.${t.name}` : undefined;
  };
  for (const rawMetric of bundle.workspace.metrics.filter((m) => m.status === "published")) {
    const metric = resolveMetric(rawMetric);
    const platformBinding = bindings.find((b) => {
      const binding = b as Record<string, unknown>;
      return binding.id === `binding.metric.${metric.id.replace(/^metric\./, "")}` || binding.metricId === metric.id;
    }) as Record<string, unknown> | undefined;
    // AnyMetrics 是权威事实源时，资产只负责指标语义、平台编码和维度声明，
    // 不应要求本地 SQL 数据集、公式或跨表维度绑定。
    const platformOnly = platformBinding?.queryMode === "metric-api"
      || (metric.provider?.providerMetricId != null && !metric.datasetName && !metric.caliber?.datasetName);
    if (!metric.provider?.providerMetricId) errors.push(`${metric.id}:缺少 providerMetricId`);
    const dataset = metric.datasetName ?? metric.caliber?.datasetName;
    if (!dataset && !platformOnly) errors.push(`${metric.id}:缺少 datasetName`);
    else if (dataset && !datasets.has(dataset)) errors.push(`${metric.id}:数据集绑定不存在:${dataset}`);
    if (!platformOnly && !metric.caliber?.formula && !metric.derivation?.type) errors.push(`${metric.id}:缺少 caliber.formula,无法安全下钻`);
    if (dataset && datasets.has(dataset) && !tableOf(datasets.get(dataset)!)) errors.push(`${metric.id}:数据集缺少物理表绑定:${dataset}`);
    const dimensionIds = new Set(bindings.filter((b) => b.id.startsWith("binding.dimension.")).map((b) => b.id));
    for (const dimension of platformOnly ? [] : (metric.dimensions ?? [])) {
      // 指标事实数据集上的本地维度无需跨表绑定;跨数据集维度必须有 binding.dimension.*。
      const localName = dimension.replace(/^dimension\./, "").replace(/-/g, "_");
      const datasetBinding = dataset ? datasets.get(dataset) : undefined;
      const localColumns = Array.isArray(datasetBinding?.allowedColumns) ? datasetBinding.allowedColumns : [];
      const localDimension = localColumns.some((column) => column === localName || column === `${localName}_code` || (dimension === "dimension.store" && column === "store_code"));
      if (!localDimension && !dimensionIds.has(`binding.dimension.${dimension.replace(/^dimension\./, "")}`)) {
        errors.push(`${metric.id}:维度绑定不存在:${dimension}`);
      }
    }
  }
  if (errors.length) {
    throw new Error(`资产分析就绪度检查失败:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }
}

if (args.has("--check")) {
  const result = loadAssetBundle(outDir);
  if (!result.bundle) {
    console.error(`资产 Bundle 校验失败: ${result.warnings.join("；")}`);
    process.exit(1);
  }
  console.log(`资产 Bundle 校验通过: ${outDir}`);
  console.log(`bundle=${result.bundle.manifest.bundleId} metrics=${result.bundle.manifest.counts.metrics} bindings=${result.bundle.manifest.counts.bindings} graphEdges=${result.bundle.manifest.counts.graphEdges}`);
  process.exit(0);
}

if (!existsSync(repoRoot)) {
  console.error(`资产仓不存在: ${repoRoot}`);
  process.exit(1);
}

const bundle = compileAssetBundle(repoRoot, workspaceId);
assertAnalysisReady(bundle);
writeAssetBundle(bundle, outDir);
const checked = loadAssetBundle(outDir);
if (!checked.bundle) {
  console.error(`资产 Bundle 写入后校验失败: ${checked.warnings.join("；")}`);
  process.exit(1);
}
console.log(`资产 Bundle 编译完成: ${outDir}`);
console.log(`bundle=${bundle.manifest.bundleId} metrics=${bundle.manifest.counts.metrics} bindings=${bundle.manifest.counts.bindings} graphEdges=${bundle.manifest.counts.graphEdges}`);
