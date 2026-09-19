/**
 * bindings 装载(datasets/tables/metrics/knowledge 四个 YAML 指针文件)。
 * 概念层(ontology.yaml)与绑定层物理分离,双版本独立演进(P1-1)。
 */
import { parse as parseYaml } from "yaml";

export interface TablePointer {
  catalog: string;
  schema: string;
  table: string;
}

export interface DatasetBinding {
  table?: TablePointer;
  connection?: string;
  description?: string;
}

export interface TableBinding {
  allowedColumns?: string[];
  sensitiveColumns?: string[];
}

export interface MetricBinding {
  metricName: string;
  source?: "anymetrics" | "local" | "derived";
}

export interface Bindings {
  version: string;
  datasets: Record<string, DatasetBinding | undefined>;
  tables: Record<string, TableBinding | undefined>;
  classMetrics: Record<string, MetricBinding[] | undefined>;
  classKnowledge: Record<string, string[] | undefined>;
  warnings: string[];
}

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function loadBindings(yamls: {
  datasetsYaml?: string;
  tablesYaml?: string;
  metricsYaml?: string;
  knowledgeYaml?: string;
}): Bindings {
  const warnings: string[] = [];
  const result: Bindings = { version: "0.0.0", datasets: {}, tables: {}, classMetrics: {}, classKnowledge: {}, warnings };

  const safeParse = (text: string | undefined, label: string): Record<string, unknown> | null => {
    if (!text || !text.trim()) {
      warnings.push(`bindings/${label} 为空`);
      return null;
    }
    try {
      const p = parseYaml(text);
      if (p && typeof p === "object") return p as Record<string, unknown>;
      warnings.push(`bindings/${label} 顶层非对象`);
      return null;
    } catch (e) {
      warnings.push(`bindings/${label} 解析失败:${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  // datasets.yaml
  const ds = safeParse(yamls.datasetsYaml, "datasets.yaml");
  if (ds && typeof ds.datasets === "object" && ds.datasets !== null) {
    for (const [name, raw] of Object.entries(ds.datasets as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const binding: DatasetBinding = {};
      if (r.table && typeof r.table === "object") {
        const t = r.table as Record<string, unknown>;
        const full = `${t.catalog}.${t.schema}.${t.table}`;
        if (TABLE_RE.test(full)) {
          binding.table = { catalog: String(t.catalog), schema: String(t.schema), table: String(t.table) };
        } else {
          warnings.push(`datasets.${name}.table 非三段式:${full}`);
        }
      }
      if (typeof r.connection === "string") binding.connection = r.connection;
      if (typeof r.description === "string") binding.description = r.description;
      result.datasets[name] = binding;
    }
  }

  // tables.yaml
  const tb = safeParse(yamls.tablesYaml, "tables.yaml");
  if (tb && typeof tb.tables === "object" && tb.tables !== null) {
    for (const [fullName, raw] of Object.entries(tb.tables as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (!TABLE_RE.test(fullName)) {
        warnings.push(`tables key 非三段式:${fullName}`);
        continue;
      }
      result.tables[fullName] = {
        allowedColumns: strList(r.allowedColumns),
        sensitiveColumns: strList(r.sensitiveColumns),
      };
    }
  }

  // metrics.yaml
  const mt = safeParse(yamls.metricsYaml, "metrics.yaml");
  if (mt && typeof mt.classMetrics === "object" && mt.classMetrics !== null) {
    for (const [className, raw] of Object.entries(mt.classMetrics as Record<string, unknown>)) {
      if (!Array.isArray(raw)) continue;
      const list: MetricBinding[] = [];
      for (const item of raw) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).metricName === "string") {
          const r = item as Record<string, unknown>;
          list.push({
            metricName: r.metricName as string,
            source: (typeof r.source === "string" ? r.source : "anymetrics") as MetricBinding["source"],
          });
        }
      }
      if (list.length > 0) result.classMetrics[className] = list;
    }
  }

  // knowledge.yaml
  const kn = safeParse(yamls.knowledgeYaml, "knowledge.yaml");
  if (kn && typeof kn.classKnowledge === "object" && kn.classKnowledge !== null) {
    for (const [className, raw] of Object.entries(kn.classKnowledge as Record<string, unknown>)) {
      const list = strList(raw);
      if (list.length > 0) result.classKnowledge[className] = list;
    }
  }

  // version(取四文件中最高的)
  const versions = [ds, tb, mt, kn].map((x) => (x && typeof x.version === "string" ? x.version : "0.0.0"));
  result.version = versions.sort().at(-1) ?? "0.0.0";

  return result;
}
