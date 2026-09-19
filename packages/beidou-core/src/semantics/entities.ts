/**
 * 实体与业务模型(semantics/entities.yaml 的结构化解析)。
 * 轻量语义资产:实体=业务对象(→维表/主数据);业务模型=分析主题(指标组合+实体+关注维度)。
 * 用途:① 进语义检索(实体/模型可被 search_semantics 命中);
 *      ② 诊断时优先采用业务模型声明的关注维度(归因维度智能选择)。
 * 容错:坏 YAML/缺字段 → 空或部分结果,不阻断装载(fail-open,页面可修复)。
 */
import { parse as parseYaml } from "yaml";

export interface EntityDef {
  name: string;
  description?: string;
  dataset?: string;
  key?: string;
  attributes: string[];
}

export interface BusinessModelDef {
  name: string;
  description?: string;
  entities: string[];
  metrics: string[];
  dimensions: string[];
}

export interface EntitiesFile {
  entities: EntityDef[];
  models: BusinessModelDef[];
}

export function parseEntities(text: string): EntitiesFile {
  if (!text.trim()) return { entities: [], models: [] };
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { entities: [], models: [] };
  }
  const raw = (parsed ?? {}) as {
    entities?: Array<Record<string, unknown>>;
    businessModels?: Array<Record<string, unknown>>;
  };
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const entities: EntityDef[] = (raw.entities ?? [])
    .filter((e) => typeof e.name === "string" && (e.name as string).length > 0)
    .map((e) => ({
      name: e.name as string,
      description: typeof e.description === "string" ? e.description : undefined,
      dataset: typeof e.dataset === "string" ? e.dataset : undefined,
      key: typeof e.key === "string" ? e.key : undefined,
      attributes: strList(e.attributes),
    }));

  const models: BusinessModelDef[] = (raw.businessModels ?? [])
    .filter((m) => typeof m.name === "string" && Array.isArray(m.metrics) && (m.metrics as unknown[]).length > 0)
    .map((m) => ({
      name: m.name as string,
      description: typeof m.description === "string" ? m.description : undefined,
      entities: strList(m.entities),
      metrics: strList(m.metrics),
      dimensions: strList(m.dimensions),
    }));

  return { entities, models };
}

/** 按指标找覆盖它的业务模型(诊断维度选择的输入) */
export function modelsForMetric(parsed: EntitiesFile, metricName: string): BusinessModelDef[] {
  return parsed.models.filter((m) => m.metrics.includes(metricName));
}
