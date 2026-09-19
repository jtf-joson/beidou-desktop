/**
 * Workspace 服务(主进程,但不 import electron —— 可单测)。
 * workspace 目录即语义资产权威源(SPEC Q2.10);本模块负责装载/合并/构建索引。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { importBeidou } from "@beidou/core/src/semantics/importer";
import { buildStore, type SemanticStore } from "@beidou/core/src/semantics/store";
import { filterAssets, parseScope, type SpaceScope } from "@beidou/core/src/spaces/scope";
import { parseMembers, type SpaceMembership, type Role } from "@beidou/core/src/rbac/rbac";
import type { GlossaryTerm, MetricMirror, SemanticAssets } from "@beidou/core/src/types";
import { readdirSync } from "node:fs";
import { parseEntities, type EntitiesFile } from "@beidou/core/src/semantics/entities";
import { parseOntology, loadBindings, type ParsedOntology, type Bindings } from "@beidou/ontology-schema/src";

export interface ModelConfig {
  provider?: "deepseek-anthropic";
  base_url?: string;
  /** 直接给 key(本地明文,gitignore)或环境变量名 */
  auth_token?: string;
  auth_token_env?: string;
  model?: string;
}

export interface StarRocksConfigFile {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  timeout_sec?: number;
  max_rows?: number;
  /** 未配置 host 时是否启用 mock 演示数据(默认 true;false = 硬性报未配置) */
  mock?: boolean;
}

export interface AnyMetricsConfigFile {
  host?: string;
  tenant_id?: string;
  auth_value?: string;
  auth_value_env?: string;
}

export interface GuardConfigFile {
  max_row?: number;
  sensitive_columns?: string[];
}

export interface AuthConfigFile {
  /** 飞书机器人 app_id(idaas-auth-protocol 协议必填);也可用环境变量 IDAAS_AUTH_APP_ID */
  app_id?: string;
  /** 认证服务地址,默认 https://idaas-auth-service.example.com */
  service_url?: string;
  /** 服务端鉴权 token(未启用可空) */
  service_token?: string;
}

export interface WorkspaceConfig {
  name?: string;
  model?: ModelConfig;
  starrocks?: StarRocksConfigFile;
  anymetrics?: AnyMetricsConfigFile;
  guard?: GuardConfigFile;
  auth?: AuthConfigFile;
}

export interface LoadedWorkspace {
  dir: string;
  name: string;
  config: WorkspaceConfig;
  assets: SemanticAssets;
  store: SemanticStore;
  metricsByCode: Map<string, MetricMirror>;
  warnings: string[];
  semanticVersion: string;
  /** 空间 scope(已应用的资产过滤) */
  scope: SpaceScope | null;
  /** 空间成员与默认角色 */
  members: SpaceMembership[];
  defaultRole: Role;
  /** 业务知识库(knowledge/*.md) */
  knowledge: Array<{ name: string; content: string }>;
  /** 业务 Playbook(playbooks/*.md) */
  playbooks: Array<{ name: string; content: string }>;
  /** 实体与业务模型(semantics/entities.yaml 原文,轻量语义资产) */
  entitiesYaml: string;
  /** 解析后的实体与业务模型(旧,Phase 2 后由 ontology 取代) */
  entities: EntitiesFile;
  /** 本体(ontology.yaml,ParsedOntology) */
  ontology: ParsedOntology;
  /** 绑定层(bindings/*.yaml) */
  bindings: Bindings;
}

// 北斗导出缓存:key=import 目录,值=解析结果;保存术语/知识等不触发重 parse
const beidouImportCache = new Map<string, SemanticAssets>();
const importCacheKey = (dir: string): string => {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const importDir = join(dir, "semantics", "import");
    const files = fs.readdirSync(importDir).sort();
    const sig = files.map((f) => {
      const st = fs.statSync(join(importDir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    }).join("|");
    return `${dir}::${sig}`;
  } catch {
    return `${dir}::nocache`;
  }
};

const readIfExists = (p: string): string | null => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

export function loadWorkspace(dir: string): LoadedWorkspace {
  const warnings: string[] = [];

  const configText = readIfExists(join(dir, "config.yaml")) ?? readIfExists(join(dir, "config.yml"));
  let config: WorkspaceConfig = {};
  if (configText) {
    try {
      config = parseYaml(configText) as WorkspaceConfig;
    } catch (e) {
      warnings.push(`config.yaml 解析失败:${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    warnings.push("缺少 config.yaml(将使用默认配置)");
  }

  // 北斗导出导入(带缓存:文件签名不变则复用上次解析结果,8.6MB 不重复 parse)
  const importDir = join(dir, "semantics", "import");
  const cacheKey = importCacheKey(dir);
  let assets: SemanticAssets;
  const cached = beidouImportCache.get(cacheKey);
  if (cached) {
    assets = { ...cached, glossary: [], importWarnings: [] }; // 浅拷贝,glossary 由下方装载覆盖
  } else if (existsSync(importDir)) {
    assets = importBeidou((name) => readIfExists(join(importDir, name)));
    beidouImportCache.set(cacheKey, { ...assets, glossary: [] });
  } else {
    warnings.push("缺少 semantics/import/(未导入北斗导出)");
    assets = importBeidou(() => null);
  }
  warnings.push(...(assets.importWarnings ?? []).map((w) => `[import] ${w}`));

  // glossary.yaml(人工维护,权威)
  const glossaryText = readIfExists(join(dir, "semantics", "glossary.yaml"));
  if (glossaryText) {
    try {
      const parsed = parseYaml(glossaryText) as { terms?: GlossaryTerm[] } | GlossaryTerm[] | null;
      const terms = Array.isArray(parsed) ? parsed : parsed?.terms ?? [];
      const valid = terms.filter(
        (t) => t && typeof t.term === "string" && Array.isArray(t.synonyms),
      );
      if (valid.length !== terms.length) warnings.push(`glossary.yaml 有 ${terms.length - valid.length} 条非法术语被忽略`);
      assets.glossary = valid;
    } catch (e) {
      warnings.push(`glossary.yaml 解析失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }


  // 空间 scope:资产层隔离(坏文件 → 告警 + 不过滤,由空间所有者修复)
  let scope: SpaceScope | null = null;
  const scopeText = readIfExists(join(dir, "semantics", "scope.yaml"));
  if (scopeText) {
    const r = parseScope(scopeText);
    if (r.ok) {
      scope = r.value;
    } else {
      warnings.push(`[scope] ${r.error.message}(已按不过滤处理,请修复)`);
    }
  }
  const scopedAssets = filterAssets(assets, scope);
  const scopedStore = buildStore(scopedAssets);
  const scopedCodes = new Map<string, MetricMirror>();
  for (const m of scopedAssets.metrics) {
    if (m.code) scopedCodes.set(m.code, m);
  }

  // 空间成员(members.yaml)
  const membersText = readIfExists(join(dir, "members.yaml"));
  const members = membersText ? parseMembers(membersText) : [];
  let defaultRole: Role = "viewer";
  if (membersText) {
    try {
      const parsed = parseYaml(membersText) as { default_role?: string } | null;
      if (parsed?.default_role && ["admin", "engineer", "analyst", "viewer"].includes(parsed.default_role)) {
        defaultRole = parsed.default_role as Role;
      }
    } catch {
      warnings.push("[members] members.yaml 解析失败(按默认角色 viewer 处理)");
    }
  }

  // 知识库与 Playbook(空间级业务资产;只认 .md)
  const readMdDir = (sub: string): Array<{ name: string; content: string }> => {
    const d = join(dir, sub);
    if (!existsSync(d)) return [];
    const out: Array<{ name: string; content: string }> = [];
    for (const f of readdirSync(d)) {
      if (f.endsWith(".md")) {
        out.push({ name: f.replace(/\.md$/, ""), content: readFileSync(join(d, f), "utf-8") });
      }
    }
    return out;
  };
  const knowledge = readMdDir("knowledge");
  const playbooks = readMdDir("playbooks");
  const entitiesYaml = readIfExists(join(dir, "semantics", "entities.yaml")) ?? "# 实体与业务模型(轻量语义资产)\nentities: []\nbusinessModels: []\n";

  // ontology.yaml + bindings/*.yaml(P2 新增;缺失 → 空 + warning,不阻断)
  const ontologyText = readIfExists(join(dir, "semantics", "ontology.yaml"));
  const ontology = parseOntology(ontologyText);
  const bindings = loadBindings({
    datasetsYaml: readIfExists(join(dir, "semantics", "bindings", "datasets.yaml")) ?? undefined,
    tablesYaml: readIfExists(join(dir, "semantics", "bindings", "tables.yaml")) ?? undefined,
    metricsYaml: readIfExists(join(dir, "semantics", "bindings", "metrics.yaml")) ?? undefined,
    knowledgeYaml: readIfExists(join(dir, "semantics", "bindings", "knowledge.yaml")) ?? undefined,
  });
  warnings.push(...ontology.warnings.map((w) => `[ontology] ${w}`));
  warnings.push(...bindings.warnings.map((w) => `[bindings] ${w}`));

  return {
    dir,
    name: config.name ?? "北斗work 空间",
    config,
    assets: scopedAssets,
    store: scopedStore,
    metricsByCode: scopedCodes,
    warnings,
    semanticVersion: `ws-${new Date().toISOString().slice(0, 10)}`,
    scope,
    members,
    defaultRole,
    knowledge,
    playbooks,
    entitiesYaml,
    entities: parseEntities(entitiesYaml),
    ontology,
    bindings,
  };
}

/** 模型在线可用:key 存在(直接或环境变量) */
export function modelConfigured(w: LoadedWorkspace): boolean {
  const m = w.config.model;
  if (!m) return false;
  if (m.auth_token && m.auth_token.length > 0) return true;
  if (m.auth_token_env && process.env[m.auth_token_env]) return true;
  return false;
}

export function resolveModelToken(w: LoadedWorkspace): string | undefined {
  const m = w.config.model;
  if (!m) return undefined;
  return m.auth_token ?? (m.auth_token_env ? process.env[m.auth_token_env] : undefined);
}
