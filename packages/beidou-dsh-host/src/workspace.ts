/**
 * Workspace 服务(主进程,但不 import electron —— 可单测)。
 * workspace 目录即语义资产权威源(SPEC Q2.10);本模块负责装载/合并/构建索引。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { importBeidou } from "@beidou/core/src/semantics/importer.ts";
import { buildStore, type SemanticStore } from "@beidou/core/src/semantics/store.ts";
import { buildSemanticGraph, type SemanticGraph } from "@beidou/core/src/semantics/graph.ts";
import { filterAssets, parseScope, type SpaceScope } from "@beidou/core/src/spaces/scope.ts";
import { parseMembers, type SpaceMembership, type Role } from "@beidou/core/src/rbac/rbac.ts";
import type { GlossaryTerm, MetricMirror, SemanticAssets } from "@beidou/core/src/types.ts";
import { readdirSync } from "node:fs";
import { parseEntities, type EntitiesFile } from "@beidou/core/src/semantics/entities.ts";
import { loadAssetWorkspace, parseOntology, loadBindings, type ParsedOntology, type Bindings, type AssetRepoWorkspace } from "@beidou/ontology-schema/src/index.ts";
import {
  assetRepoToSemanticAssets,
  assetRepoToOntology,
  assetRepoPlaybooks,
  assetRepoKnowledge,
  assetRepoSemanticVersion,
} from "./asset-bridge.ts";
import { loadAssetBundle, type LoadedAssetBundle } from "./asset-bundle.ts";

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
  semantic_host?: string;
  tenant_id?: string;
  auth_type?: string;
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
  /** 资产仓源(五层语义资产权威):配置后 metrics/glossary/本体/知识/Playbook 从
   *  beidou-workspace 仓装载,取代 semantics/import 北斗导出;运行时配置仍留空间目录 */
  asset_repo?: {
    /** 资产仓根目录(含 workspaces/);相对路径按空间目录解析 */
    root: string;
    workspace: string;
    /** 装载前 git pull --ff-only 拉最新(离线/冲突/非 git 目录 → 告警降级用本地) */
    auto_pull?: boolean;
  };
  /** Release Bundle 目录(manifest/assets/graph/checksums;优先于 asset_repo,
   *  校验失败自动回退 asset_repo)——空间锁定不可变快照,版本=bundleId */
  asset_bundle?: string;
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
  /** 当前运行时实际使用的语义资产来源,用于结果解释和运维排障。 */
  assetSource: "bundle" | "asset-repo" | "legacy-import";
  assetBundleId?: string;
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
  /** 语义图(资产仓模式:装载期物化 relatesTo/measuredBy/derivedFrom/uses* 边;旧模式缺省) */
  graph?: SemanticGraph;
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

// 资产仓装载缓存:工作区文件签名(名/大小/mtime)不变则复用解析结果,400+ YAML 不重复 parse
const assetRepoCache = new Map<string, AssetRepoWorkspace>();
function repoSignature(root: string, workspaceId: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          const st = statSync(full);
          parts.push(`${e.name}:${st.size}:${st.mtimeMs}`);
        } catch {
          /* 文件消失则跳过 */
        }
      }
    }
  };
  walk(join(root, "workspaces", workspaceId));
  return `${root}::${workspaceId}::${parts.join("|")}`;
}

/** 装载 Release Bundle(fail-closed 校验;失败返回 null 由调用方回退) */
const loadBundleSource = (
  config: WorkspaceConfig,
  dir: string,
  warnings: string[],
): LoadedAssetBundle | null => {
  const p = config.asset_bundle;
  if (!p) return null;
  const bundleDir = isAbsolute(p) ? p : resolve(dir, p);
  const r = loadAssetBundle(bundleDir);
  warnings.push(...r.warnings.map((w) => `[asset-bundle] ${w}`));
  if (r.bundle) warnings.push(...r.bundle.workspace.warnings.map((w) => `[asset-bundle] ${w}`));
  return r.bundle;
};

/** 装载资产仓源(fail-open:目录/文件问题 → 告警 + 空资产,不阻断空间启动) */
const loadRepoSource = (
  config: WorkspaceConfig,
  dir: string,
  warnings: string[],
): AssetRepoWorkspace | null => {
  const cfg = config.asset_repo;
  if (!cfg?.root || !cfg.workspace) return null;
  const configuredRoot = isAbsolute(cfg.root) ? cfg.root : resolve(dir, cfg.root);
  // 开发环境通常已有独立的 beidou-workspace Git checkout。优先使用显式环境变量，
  // 避免把随安装包复制出来的 asset-repo 目录误当成 Git 仓库。
  const envRoot = process.env.BEIDOU_ASSET_REPO?.replace(/\/$/, "");
  const packagedAssetRepo = cfg.root === "asset-repo" || cfg.root.endsWith("/asset-repo");
  const root = packagedAssetRepo && envRoot && existsSync(join(envRoot, ".git")) ? envRoot : configuredRoot;
  if (cfg.auto_pull) {
    try {
      execSync("git pull --ff-only", { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      warnings.push(`[asset-repo] auto_pull 失败,降级用本地现状:${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  try {
    const sig = repoSignature(root, cfg.workspace);
    let ws = assetRepoCache.get(sig);
    if (!ws) {
      ws = loadAssetWorkspace(root, cfg.workspace);
      assetRepoCache.set(sig, ws);
    }
    warnings.push(...ws.warnings.map((w) => `[asset-repo] ${w}`));
    return ws;
  } catch (e) {
    warnings.push(`[asset-repo] 装载失败:${e instanceof Error ? e.message : String(e)}`);
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

  // 语义资产来源:Release Bundle(不可变快照)> 资产仓(asset_repo 五层 YAML)> 北斗 JSON 导出
  const bundle = loadBundleSource(config, dir, warnings);
  const repo = bundle?.workspace ?? loadRepoSource(config, dir, warnings);
  const importDir = join(dir, "semantics", "import");
  const cacheKey = importCacheKey(dir);
  let assets: SemanticAssets;
  if (repo) {
    assets = assetRepoToSemanticAssets(repo);
  } else {
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
  }
  if (!repo) warnings.push(...(assets.importWarnings ?? []).map((w) => `[import] ${w}`));

  // glossary.yaml(人工维护,权威;资产仓模式下术语已随装载进入,跳过)
  if (!repo) {
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
  const knowledge = repo ? assetRepoKnowledge(repo) : readMdDir("knowledge");
  const playbooks = repo ? assetRepoPlaybooks(repo) : readMdDir("playbooks");
  const entitiesYaml = readIfExists(join(dir, "semantics", "entities.yaml")) ?? "# 实体与业务模型(轻量语义资产)\nentities: []\nbusinessModels: []\n";

  // 本体:资产仓模式取五层 Class/Relation/Action;否则旧 ontology.yaml(P2 格式)
  const ontology = repo
    ? assetRepoToOntology(repo)
    : parseOntology(readIfExists(join(dir, "semantics", "ontology.yaml")));
  const bindings = loadBindings({
    datasetsYaml: readIfExists(join(dir, "semantics", "bindings", "datasets.yaml")) ?? undefined,
    tablesYaml: readIfExists(join(dir, "semantics", "bindings", "tables.yaml")) ?? undefined,
    metricsYaml: readIfExists(join(dir, "semantics", "bindings", "metrics.yaml")) ?? undefined,
    knowledgeYaml: readIfExists(join(dir, "semantics", "bindings", "knowledge.yaml")) ?? undefined,
  });
  warnings.push(...ontology.warnings.map((w) => `[ontology] ${w}`));
  if (!repo) warnings.push(...bindings.warnings.map((w) => `[bindings] ${w}`));

  return {
    dir,
    name: config.name ?? "北斗work 空间",
    config,
    assets: scopedAssets,
    store: scopedStore,
    metricsByCode: scopedCodes,
    warnings,
    semanticVersion: bundle
      ? bundle.manifest.bundleId
      : repo
        ? assetRepoSemanticVersion(repo)
        : `ws-${new Date().toISOString().slice(0, 10)}`,
    assetSource: bundle ? "bundle" : repo ? "asset-repo" : "legacy-import",
    assetBundleId: bundle?.manifest.bundleId,
    scope,
    members,
    defaultRole,
    knowledge,
    playbooks,
    entitiesYaml,
    entities: parseEntities(entitiesYaml),
    ontology,
    graph: bundle?.graph ?? (repo ? buildSemanticGraph(repo) : undefined),
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
