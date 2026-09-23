/**
 * beidou-workspace 资产仓装载器(五层语义资产 → TypeScript)。
 * 目录即权威源(workspaces/<id>/ 下五层 YAML);本模块只做容错解析(fail-open:
 * 坏文件告警跳过,不阻断装载),语义映射到 SemanticAssets/ParsedOntology 由
 * beidou-dsh-host 的 asset-bridge 完成。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** 资产治理状态(资产仓 L5;OFFLINE 导入时已映射为 deprecated) */
export type AssetRepoStatus = "draft" | "published" | "deprecated";

export interface AssetRepoTerm {
  id: string;
  name: string;
  status?: string;
  definition?: string;
  aliases?: string[];
  abbreviations?: string[];
  owners?: string[];
}

export interface AssetRepoClassProperty {
  id: string;
  name?: string;
  datatype: string;
  required?: boolean;
  dictionaryRef?: string;
}

export interface AssetRepoClass {
  id: string;
  name: string;
  status?: string;
  domain?: string;
  subdomain?: string;
  topic?: string;
  key?: string;
  description?: string;
  aliases?: string[];
  owners?: string[];
  properties: AssetRepoClassProperty[];
}

export interface AssetRepoRelation {
  id: string;
  name: string;
  status?: string;
  domain: string;
  range: string;
  cardinality?: string;
  bindingRef?: string;
  description?: string;
}

export interface AssetRepoAction {
  id: string;
  name: string;
  status?: string;
  subject: string;
  relatedMetrics?: string[];
  playbooks?: string[];
  description?: string;
}

export interface AssetRepoMetricContract {
  id: string;
  name: string;
  status?: string;
  aliases?: string[];
  subject?: string;
  definition?: string;
  unit?: string;
  valueType?: string;
  aggregation?: string;
  dimensions?: string[];
  datasetName?: string;
  caliber?: { datasetName?: string; formula?: unknown; metricTime?: string; filters?: Array<{ type?: string; expr?: string }> };
  provider?: { type?: string; providerMetricId?: string };
  owners?: string[];
  derivation?: { type?: string; formula?: string; baseMetric?: string };
  imported?: { metricType?: string; platformStatus?: string };
}

/** 指标平台维度快照中的权威字段名及展示信息。 */
export interface AssetRepoPlatformDimension {
  dimName: string;
  dimCode?: string;
  dimDisplayName?: string;
  datasetName?: string;
}

export interface AssetRepoPlaybookStep {
  id?: string;
  name?: string;
  rule?: string;
  metrics?: string[];
  knowledge?: string[];
}

export interface AssetRepoSkill {
  id: string;
  name?: string;
  status?: string;
  requires?: { metrics?: string[]; knowledge?: string[]; playbooks?: string[] };
}

export interface AssetRepoPolicy {
  id: string;
  name?: string;
  status?: string;
}

export interface AssetRepoAcl {
  id: string;
  name?: string;
  status?: string;
}

export interface AssetRepoOutputSchema {
  id: string;
  name?: string;
  status?: string;
}

export interface AssetRepoPlaybook {
  id: string;
  name?: string;
  status?: string;
  steps?: AssetRepoPlaybookStep[];
}

export interface AssetRepoKnowledgePage {
  name: string;
  content: string;
}

export interface AssetRepoBinding {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export interface AssetRepoWorkspace {
  /** 资产仓根目录(含 workspaces/) */
  root: string;
  workspaceId: string;
  /** workspace.yaml 的 name,缺省用 workspaceId */
  name: string;
  /** active-release.yaml 的 releaseId;未发布为 null */
  releaseId: string | null;
  terms: AssetRepoTerm[];
  classes: AssetRepoClass[];
  relations: AssetRepoRelation[];
  actions: AssetRepoAction[];
  metrics: AssetRepoMetricContract[];
  playbooks: AssetRepoPlaybook[];
  skills: AssetRepoSkill[];
  policies: AssetRepoPolicy[];
  acls: AssetRepoAcl[];
  outputSchemas: AssetRepoOutputSchema[];
  knowledge: AssetRepoKnowledgePage[];
  /** 物理绑定层：保留原始结构，供运行时桥接到 SemanticAssets。 */
  bindings: AssetRepoBinding[];
  /** sources/*dimensions*.json 的平台维度快照，按 providerMetricId 索引。 */
  platformDimensions: Record<string, AssetRepoPlatformDimension[]>;
  warnings: string[];
}

const readIfExists = (p: string): string | null => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

/** 扫描目录下全部 YAML 文件;坏文件 → 告警跳过(fail-open) */
function readYamlDir<T>(dir: string, warnPrefix: string, warnings: string[]): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = readIfExists(join(dir, f));
    if (text === null) continue;
    try {
      const parsed = parseYaml(text) as T | null;
      if (parsed && typeof parsed === "object") out.push(parsed);
      else warnings.push(`${warnPrefix}${f}:空文件已跳过`);
    } catch (e) {
      warnings.push(`${warnPrefix}${f}:YAML 解析失败(${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return out;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** 规范化各层文件字段(容忍多余字段与缺省;id/name 缺失的条目告警丢弃) */
function normalizeTerm(raw: Record<string, unknown>): AssetRepoTerm | null {
  const id = asString(raw.id);
  const name = asString(raw.name) ?? asString(raw["rdfs:label"]);
  if (!id || !name) return null;
  return {
    id,
    name,
    status: asString(raw.status),
    definition: asString(raw.definition),
    aliases: asStringArray(raw.aliases),
    abbreviations: asStringArray(raw.abbreviations),
    owners: asStringArray(raw.owners),
  };
}

function normalizeClass(raw: Record<string, unknown>): AssetRepoClass | null {
  const id = asString(raw.id);
  const name = asString(raw.name);
  if (!id || !name) return null;
  const props: AssetRepoClassProperty[] = Array.isArray(raw.properties)
    ? (raw.properties as Array<Record<string, unknown>>)
        .filter((p) => asString(p?.id))
        .map((p) => ({
          id: asString(p.id)!,
          name: asString(p.name),
          datatype: asString(p.datatype) ?? "string",
          required: p.required === true,
          dictionaryRef: asString(p.dictionaryRef),
        }))
    : [];
  return {
    id,
    name,
    status: asString(raw.status),
    domain: asString(raw.domain),
    subdomain: asString(raw.subdomain),
    topic: asString(raw.topic),
    key: asString(raw.key),
    description: asString(raw.description),
    aliases: asStringArray(raw.aliases),
    owners: asStringArray(raw.owners),
    properties: props,
  };
}

function normalizeRelation(raw: Record<string, unknown>): AssetRepoRelation | null {
  const id = asString(raw.id);
  const domain = asString(raw.domain);
  const range = asString(raw.range);
  if (!id || !domain || !range) return null;
  return {
    id,
    name: asString(raw.name) ?? id,
    status: asString(raw.status),
    domain,
    range,
    cardinality: asString(raw.cardinality),
    bindingRef: asString(raw.bindingRef),
    description: asString(raw.description),
  };
}

function normalizeAction(raw: Record<string, unknown>): AssetRepoAction | null {
  const id = asString(raw.id);
  const subject = asString(raw.subject);
  if (!id || !subject) return null;
  return {
    id,
    name: asString(raw.name) ?? id,
    status: asString(raw.status),
    subject,
    relatedMetrics: asStringArray(raw.relatedMetrics) ?? asStringArray(raw.metrics) ?? [],
    playbooks: asStringArray(raw.playbooks) ?? [],
    description: asString(raw.description),
  };
}

function normalizeMetric(raw: Record<string, unknown>): AssetRepoMetricContract | null {
  const id = asString(raw.id);
  const name = asString(raw.name);
  if (!id || !name) return null;
  const provider = (raw.provider ?? null) as Record<string, unknown> | null;
  const derivation = (raw.derivation ?? null) as Record<string, unknown> | null;
  const imported = (raw.imported ?? null) as Record<string, unknown> | null;
  return {
    id,
    name,
    status: asString(raw.status),
    aliases: asStringArray(raw.aliases),
    subject: asString(raw.subject),
    definition: asString(raw.definition),
    unit: asString(raw.unit),
    valueType: asString(raw.valueType),
    aggregation: asString(raw.aggregation),
    dimensions: asStringArray(raw.dimensions) ?? [],
    datasetName: asString(raw.datasetName),
    caliber: raw.caliber && typeof raw.caliber === "object"
      ? {
          datasetName: asString((raw.caliber as Record<string, unknown>).datasetName),
          formula: (raw.caliber as Record<string, unknown>).formula,
          metricTime: asString((raw.caliber as Record<string, unknown>).metricTime),
          filters: Array.isArray((raw.caliber as Record<string, unknown>).filters) ? (raw.caliber as Record<string, unknown>).filters as Array<{ type?: string; expr?: string }> : undefined,
        }
      : undefined,
    provider: provider
      ? { type: asString(provider.type), providerMetricId: asString(provider.providerMetricId) }
      : undefined,
    owners: asStringArray(raw.owners),
    derivation: derivation
      ? {
          type: asString(derivation.type),
          formula: asString(derivation.formula),
          baseMetric: asString(derivation.baseMetric),
        }
      : undefined,
    imported: imported
      ? { metricType: asString(imported.metricType), platformStatus: asString(imported.platformStatus) }
      : undefined,
  };
}

function normalizePlaybook(raw: Record<string, unknown>): AssetRepoPlaybook | null {
  const id = asString(raw.id);
  if (!id) return null;
  const steps = Array.isArray(raw.steps)
    ? (raw.steps as Array<Record<string, unknown>>).map((s) => ({
        id: asString(s.id),
        name: asString(s.name),
        rule: asString(s.rule),
        metrics: asStringArray(s.metrics),
        knowledge: asStringArray(s.knowledge),
      }))
    : [];
  return { id, name: asString(raw.name), status: asString(raw.status), steps };
}

function normalizeSkill(raw: Record<string, unknown>): AssetRepoSkill | null {
  const id = asString(raw.id);
  if (!id) return null;
  const requires = (raw.requires ?? null) as Record<string, unknown> | null;
  return {
    id,
    name: asString(raw.name),
    status: asString(raw.status),
    requires: requires
      ? {
          metrics: asStringArray(requires.metrics),
          knowledge: asStringArray(requires.knowledge),
          playbooks: asStringArray(requires.playbooks),
        }
      : undefined,
  };
}

function normalizeIdName(raw: Record<string, unknown>): { id: string; name?: string; status?: string } | null {
  const id = asString(raw.id);
  return id ? { id, name: asString(raw.name), status: asString(raw.status) } : null;
}

function collect<T>(items: Array<Record<string, unknown>>, normalize: (r: Record<string, unknown>) => T | null, warnPrefix: string, warnings: string[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const n = normalize(item);
    if (n) out.push(n);
    else warnings.push(`${warnPrefix}缺少 id/name 必填字段,已丢弃`);
  }
  return out;
}

function readKnowledgePages(dir: string): AssetRepoKnowledgePage[] {
  if (!existsSync(dir)) return [];
  const out: AssetRepoKnowledgePage[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const content = readIfExists(join(dir, f));
    if (content !== null) out.push({ name: f.replace(/\.md$/, ""), content });
  }
  return out;
}

/**
 * 读取指标平台维度快照。快照是资产仓的来源证据，不作为运行时网络依赖；
 * 文件损坏只产生告警，指标仍可通过无维度查询或平台详情链路工作。
 */
function readPlatformDimensions(dir: string, warnings: string[]): Record<string, AssetRepoPlatformDimension[]> {
  if (!existsSync(dir)) return {};
  const merged: Record<string, AssetRepoPlatformDimension[]> = {};
  for (const file of readdirSync(dir).sort()) {
    if (!/dimensions.*\.json$/i.test(file)) continue;
    const text = readIfExists(join(dir, file));
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text) as { raw?: Record<string, unknown> };
      const raw = parsed?.raw;
      if (!raw || typeof raw !== "object") {
        warnings.push(`[sources] ${file}:缺少 raw 维度快照`);
        continue;
      }
      for (const [metricName, value] of Object.entries(raw)) {
        if (!Array.isArray(value)) continue;
        const dims = value
          .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
          .map((d) => ({
            dimName: asString(d.dimName),
            dimCode: asString(d.dimCode),
            dimDisplayName: asString(d.dimDisplayName),
            datasetName: asString(d.datasetName),
          }))
          .filter((d): d is AssetRepoPlatformDimension => !!d.dimName);
        if (dims.length > 0) merged[metricName] = dims;
      }
    } catch (e) {
      warnings.push(`[sources] ${file}:JSON 解析失败(${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return merged;
}

/**
 * 装载资产仓中的一个工作区(fail-open:目录缺失/文件损坏 → 告警 + 空数组,不抛异常)。
 * root 指向资产仓根目录(其下有 workspaces/<workspaceId>/)。
 */
export function loadAssetWorkspace(root: string, workspaceId: string): AssetRepoWorkspace {
  const warnings: string[] = [];
  const wsDir = join(root, "workspaces", workspaceId);
  if (!existsSync(wsDir)) {
    warnings.push(`工作区目录不存在:${wsDir}`);
  }

  const wsMetaText = readIfExists(join(wsDir, "workspace.yaml")) ?? readIfExists(join(wsDir, "workspace.yml"));
  let wsName = workspaceId;
  if (wsMetaText) {
    try {
      wsName = asString((parseYaml(wsMetaText) as Record<string, unknown> | null)?.name) ?? workspaceId;
    } catch {
      warnings.push("workspace.yaml 解析失败(名称回退为 workspaceId)");
    }
  }

  let releaseId: string | null = null;
  const releaseText = readIfExists(join(wsDir, "active-release.yaml"));
  if (releaseText) {
    try {
      releaseId = asString((parseYaml(releaseText) as Record<string, unknown> | null)?.releaseId) ?? null;
    } catch {
      warnings.push("active-release.yaml 解析失败(按未发布处理)");
    }
  }

  const terms = collect(readYamlDir(join(wsDir, "01-glossary", "terms"), "[terms] ", warnings), normalizeTerm, "[terms] ", warnings);
  const classes = collect(readYamlDir(join(wsDir, "02-ontology", "classes"), "[classes] ", warnings), normalizeClass, "[classes] ", warnings);
  const relations = collect(readYamlDir(join(wsDir, "02-ontology", "relations"), "[relations] ", warnings), normalizeRelation, "[relations] ", warnings);
  const actions = collect(readYamlDir(join(wsDir, "02-ontology", "actions"), "[actions] ", warnings), normalizeAction, "[actions] ", warnings);
  const metrics = collect(readYamlDir(join(wsDir, "03-metrics", "contracts"), "[metrics] ", warnings), normalizeMetric, "[metrics] ", warnings);
  const playbooks = collect(readYamlDir(join(wsDir, "04-playbooks", "playbooks"), "[playbooks] ", warnings), normalizePlaybook, "[playbooks] ", warnings);
  const skills = collect(readYamlDir(join(wsDir, "04-playbooks", "skills"), "[skills] ", warnings), normalizeSkill, "[skills] ", warnings);
  const policies = collect(readYamlDir(join(wsDir, "05-governance", "policies"), "[policies] ", warnings), normalizeIdName, "[policies] ", warnings);
  const acls = collect(readYamlDir(join(wsDir, "05-governance", "acl"), "[acl] ", warnings), normalizeIdName, "[acl] ", warnings);
  const outputSchemas = collect(readYamlDir(join(wsDir, "04-playbooks", "output-schemas"), "[output-schemas] ", warnings), normalizeIdName, "[output-schemas] ", warnings);
  const knowledge = readKnowledgePages(join(wsDir, "knowledge", "pages"));
  const platformDimensions = readPlatformDimensions(join(wsDir, "sources"), warnings);
  const bindings = [
    ...readYamlDir<Record<string, unknown>>(join(wsDir, "bindings", "datasets"), "[bindings/datasets] ", warnings),
    ...readYamlDir<Record<string, unknown>>(join(wsDir, "bindings", "tables"), "[bindings/tables] ", warnings),
    ...readYamlDir<Record<string, unknown>>(join(wsDir, "bindings", "metric-platform"), "[bindings/metric-platform] ", warnings),
    ...readYamlDir<Record<string, unknown>>(join(wsDir, "bindings", "relations"), "[bindings/relations] ", warnings),
    ...readYamlDir<Record<string, unknown>>(join(wsDir, "bindings", "knowledge"), "[bindings/knowledge] ", warnings),
    ...readYamlDir<Record<string, unknown>>(join(wsDir, "bindings", "dimensions"), "[bindings/dimensions] ", warnings),
  ].filter((b): b is AssetRepoBinding => typeof b.id === "string");
  // 指标契约中的 provider 回指是绑定层的权威声明；没有单独 YAML 时
  // 物化为内存 binding，避免平台指标在运行时被误报为“无绑定”。
  const boundMetricIds = new Set(bindings.map((b) => b.metricId).filter((id): id is string => typeof id === "string"));
  for (const metric of metrics) {
    const providerMetricId = metric.provider?.providerMetricId;
    if (!providerMetricId || boundMetricIds.has(metric.id)) continue;
    bindings.push({
      id: `binding.metric.${metric.id.replace(/^metric\./, "")}`,
      status: metric.status ?? "published",
      metricId: metric.id,
      provider: { type: metric.provider?.type ?? "enterprise-metric-platform", providerMetricId },
      queryMode: "metric-api",
      generated: true,
    });
  }

  return {
    root,
    workspaceId,
    name: wsName,
    releaseId,
    terms,
    classes,
    relations,
    actions,
    metrics,
    playbooks,
    skills,
    policies,
    acls,
    outputSchemas,
    knowledge,
    bindings,
    platformDimensions,
    warnings,
  };
}
