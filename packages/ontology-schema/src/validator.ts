/**
 * validateOntology:fail-closed(CI/publish 用;error 级 issue → 拒绝发布)。
 * 返回 ValidationIssue[];level=error 阻断,warn 仅提示。
 */
import type { ParsedOntology } from "./types";

export interface ValidationIssue {
  level: "error" | "warn";
  rule: string;
  path: string;
  message: string;
}

export function validateOntology(ont: ParsedOntology): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const subIds = new Set(ont.domain.subdomains.map((s) => s.id));
  const classIds = new Set(ont.classes.map((c) => c.id));

  if (ont.schemaVersion !== 1) {
    issues.push({ level: "error", rule: "SCHEMA_VERSION_INVALID", path: "schemaVersion", message: `必须为 1,实际 ${ont.schemaVersion}` });
  }
  if (!ont.version || !/^\d+\.\d+\.\d+$/.test(ont.version)) {
    issues.push({ level: "error", rule: "VERSION_INVALID", path: "version", message: `semver 格式,实际 "${ont.version}"` });
  }
  if (ont.domain.subdomains.length === 0) {
    issues.push({ level: "error", rule: "NO_SUBDOMAINS", path: "domain.subdomains", message: "至少一个 subdomain" });
  }

  // class id 重复
  const seen = new Set<string>();
  for (const c of ont.classes) {
    if (seen.has(c.id)) {
      issues.push({ level: "error", rule: "DUPLICATE_ID", path: `classes.${c.id}`, message: `class id 重复` });
    }
    seen.add(c.id);
  }

  for (const c of ont.classes) {
    const p = `classes.${c.id}`;
    if (!subIds.has(c.subdomain)) {
      issues.push({ level: "error", rule: "SUBDOMAIN_NOT_FOUND", path: `${p}.subdomain`, message: `"${c.subdomain}" 不在 domain.subdomains 中` });
    }
    if (c.topic) {
      const sub = ont.domain.subdomains.find((s) => s.id === c.subdomain);
      if (sub && !sub.topics.includes(c.topic)) {
        issues.push({ level: "error", rule: "TOPIC_NOT_IN_SUBDOMAIN", path: `${p}.topic`, message: `"${c.topic}" 不在 ${c.subdomain}.topics 中` });
      }
    }
    if (c.extends) {
      if (!classIds.has(c.extends)) {
        issues.push({ level: "error", rule: "EXTENDS_NOT_FOUND", path: `${p}.extends`, message: `"${c.extends}" 不存在` });
      }
    }
    if (c.key && !c.properties.some((prop) => prop.id === c.key)) {
      issues.push({ level: "error", rule: "KEY_NOT_IN_PROPERTIES", path: `${p}.key`, message: `"${c.key}" 不在 properties 中` });
    }
  }

  // extends 环检测(DFS)
  const extendsMap = new Map(ont.classes.filter((c) => c.extends).map((c) => [c.id, c.extends!]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      issues.push({ level: "error", rule: "EXTENDS_CYCLE", path: `classes.${id}`, message: `extends 形成环` });
      return;
    }
    visiting.add(id);
    const parent = extendsMap.get(id);
    if (parent && classIds.has(parent)) dfs(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of extendsMap.keys()) dfs(id);

  for (const r of ont.relations) {
    const p = `relations.${r.id}`;
    if (!classIds.has(r.domain)) {
      issues.push({ level: "error", rule: "RELATION_CLASS_NOT_FOUND", path: `${p}.domain`, message: `"${r.domain}" 不存在` });
    }
    if (!classIds.has(r.range)) {
      issues.push({ level: "error", rule: "RELATION_CLASS_NOT_FOUND", path: `${p}.range`, message: `"${r.range}" 不存在` });
    }
  }

  for (const a of ont.actions) {
    const p = `actions.${a.id}`;
    if (!classIds.has(a.subject)) {
      issues.push({ level: "error", rule: "ACTION_SUBJECT_NOT_FOUND", path: `${p}.subject`, message: `"${a.subject}" 不存在` });
    }
    if (!subIds.has(a.subdomain)) {
      issues.push({ level: "error", rule: "SUBDOMAIN_NOT_FOUND", path: `${p}.subdomain`, message: `"${a.subdomain}" 不存在` });
    }
  }

  return issues;
}
