/**
 * parseOntology:fail-open(坏文件→空/部分结果+warning,不阻断装载)。
 * 对应 CODE_STANDARDS §1.3:运行时搜索/预览用 fail-open;发布/CI 用 validateOntology(fail-closed)。
 */
import { parse as parseYaml } from "yaml";
import type {
  OntologyClass, OntologyDomain, OntologyRelation, OntologyAction,
  OntologySubdomain, OntologyProperty, OntologyStatus, ParsedOntology,
} from "./types";

const STATUSES = new Set(["active", "draft", "deprecated"]);

const asStatus = (v: unknown): OntologyStatus =>
  typeof v === "string" && STATUSES.has(v) ? (v as OntologyStatus) : "draft";

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const parseSubdomain = (raw: Record<string, unknown>): OntologySubdomain | null => {
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  return {
    id: raw.id,
    name: raw.name,
    status: asStatus(raw.status),
    topics: strList(raw.topics),
    owners: strList(raw.owners),
  };
};

const parseProperty = (raw: Record<string, unknown>): OntologyProperty | null => {
  if (typeof raw.id !== "string" || typeof raw.datatype !== "string") return null;
  const dt = raw.datatype;
  if (!["string", "number", "boolean", "date", "enum", "json"].includes(dt)) return null;
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    datatype: dt as OntologyProperty["datatype"],
    required: raw.required === true,
    description: typeof raw.description === "string" ? raw.description : undefined,
    enumRef: typeof raw.enumRef === "string" ? raw.enumRef : undefined,
    sensitivity: typeof raw.sensitivity === "string" ? raw.sensitivity as OntologyProperty["sensitivity"] : undefined,
  };
};

const parseClass = (raw: Record<string, unknown>): OntologyClass | null => {
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.subdomain !== "string") return null;
  const props = Array.isArray(raw.properties)
    ? raw.properties.filter((p): p is Record<string, unknown> => p !== null && typeof p === "object").map(parseProperty).filter((p): p is OntologyProperty => p !== null)
    : [];
  return {
    id: raw.id,
    name: raw.name,
    subdomain: raw.subdomain,
    topic: typeof raw.topic === "string" ? raw.topic : undefined,
    extends: typeof raw.extends === "string" ? raw.extends : undefined,
    key: typeof raw.key === "string" ? raw.key : undefined,
    properties: props,
    metrics: strList(raw.metrics),
    status: asStatus(raw.status),
    description: typeof raw.description === "string" ? raw.description : undefined,
    owners: strList(raw.owners),
    tags: strList(raw.tags),
  };
};

const parseRelation = (raw: Record<string, unknown>): OntologyRelation | null => {
  if (typeof raw.id !== "string" || typeof raw.domain !== "string" || typeof raw.range !== "string") return null;
  let via: OntologyRelation["via"] | undefined;
  if (raw.via && typeof raw.via === "object") {
    const v = raw.via as Record<string, unknown>;
    if (typeof v.dataset === "string" && v.keys && typeof v.keys === "object") {
      const keys: Record<string, string> = {};
      for (const [k, val] of Object.entries(v.keys as Record<string, unknown>)) {
        if (typeof val === "string") keys[k] = val;
      }
      via = { dataset: v.dataset, keys };
    }
  }
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    domain: raw.domain,
    range: raw.range,
    cardinality: raw.cardinality as OntologyRelation["cardinality"],
    via,
    inverseOf: typeof raw.inverseOf === "string" ? raw.inverseOf : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
};

const parseAction = (raw: Record<string, unknown>): OntologyAction | null => {
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.subdomain !== "string" || typeof raw.subject !== "string") return null;
  const metrics = strList(raw.metrics);
  if (metrics.length === 0) return null;
  return {
    id: raw.id,
    name: raw.name,
    subdomain: raw.subdomain,
    subject: raw.subject,
    metrics,
    dims: strList(raw.dims),
    playbook: typeof raw.playbook === "string" ? raw.playbook : undefined,
    skills: strList(raw.skills),
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
};

const EMPTY_DOMAIN: OntologyDomain = { id: "", name: "", subdomains: [] };

export function parseOntology(text: string | null | undefined): ParsedOntology {
  const warnings: string[] = [];
  if (!text || !text.trim()) {
    return { schemaVersion: 0, version: "0.0.0", domain: EMPTY_DOMAIN, classes: [], relations: [], actions: [], warnings: ["ontology.yaml 为空"] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    return { schemaVersion: 0, version: "0.0.0", domain: EMPTY_DOMAIN, classes: [], relations: [], actions: [], warnings: [`YAML 解析失败:${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { schemaVersion: 0, version: "0.0.0", domain: EMPTY_DOMAIN, classes: [], relations: [], actions: [], warnings: ["YAML 顶层不是对象"] };
  }
  const raw = parsed as Record<string, unknown>;

  // domain
  let domain = EMPTY_DOMAIN;
  if (raw.domain && typeof raw.domain === "object") {
    const d = raw.domain as Record<string, unknown>;
    const subs = Array.isArray(d.subdomains)
      ? d.subdomains.filter((s): s is Record<string, unknown> => s !== null && typeof s === "object").map(parseSubdomain).filter((s): s is OntologySubdomain => s !== null)
      : [];
    if (subs.length === 0) warnings.push("domain.subdomains 为空或全部非法");
    domain = {
      id: typeof d.id === "string" ? d.id : "",
      name: typeof d.name === "string" ? d.name : "",
      subdomains: subs,
    };
  } else {
    warnings.push("缺少 domain 段");
  }

  // classes
  const classes: OntologyClass[] = [];
  const rawClasses = Array.isArray(raw.classes) ? raw.classes : [];
  for (const rc of rawClasses) {
    if (rc === null || typeof rc !== "object") continue;
    const c = parseClass(rc as Record<string, unknown>);
    if (c) classes.push(c);
    else warnings.push(`class 跳过(缺 id/name/subdomain):${JSON.stringify(rc).slice(0, 60)}`);
  }

  // relations
  const relations: OntologyRelation[] = [];
  const rawRels = Array.isArray(raw.relations) ? raw.relations : [];
  for (const rr of rawRels) {
    if (rr === null || typeof rr !== "object") continue;
    const rel = parseRelation(rr as Record<string, unknown>);
    if (rel) relations.push(rel);
  }

  // actions
  const actions: OntologyAction[] = [];
  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  for (const ra of rawActions) {
    if (ra === null || typeof ra !== "object") continue;
    const act = parseAction(ra as Record<string, unknown>);
    if (act) actions.push(act);
  }

  return {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0,
    version: typeof raw.version === "string" ? raw.version : "0.0.0",
    domain,
    classes,
    relations,
    actions,
    warnings,
  };
}
