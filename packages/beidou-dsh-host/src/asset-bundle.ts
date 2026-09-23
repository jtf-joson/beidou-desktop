/**
 * Release Bundle(方案 §6 简化 JSON 形态):资产仓工作区 → 不可变快照。
 * compileAssetBundle(构建期,fail-fast)→ writeAssetBundle(manifest/assets/graph/checksums)
 * → loadAssetBundle(运行期,fail-closed:逐文件 sha256 + 清单计数双重校验)。
 * bundle 是"编译型架构"的产物边界:Runtime 只消费 bundle,不回读 Git 工作区;
 * SQLite registry 形态(方案 §7)后续在 bundle 内替换 assets.json/graph.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  loadAssetWorkspace,
  type AssetRepoWorkspace,
} from "@beidou/ontology-schema/src/index.ts";
import {
  buildSemanticGraph,
  type SemanticGraph,
  type SemanticGraphEdge,
} from "@beidou/core/src/semantics/graph.ts";

export interface AssetBundleManifest {
  bundleId: string;
  workspaceId: string;
  workspaceName: string;
  releaseId: string | null;
  compiledAt: string;
  source: { root: string; gitSha?: string };
  counts: {
    terms: number;
    classes: number;
    relations: number;
    actions: number;
    metrics: number;
    playbooks: number;
    skills: number;
    knowledge: number;
    bindings: number;
    graphEdges: number;
  };
}

export interface CompiledAssetBundle {
  manifest: AssetBundleManifest;
  /** 工作区快照(五层资产 + 知识页全文) */
  workspace: AssetRepoWorkspace;
  /** 装载期物化的图边(写盘为 graph.json;加载时重建并校验数量) */
  graphEdges: SemanticGraphEdge[];
}

export interface LoadedAssetBundle {
  manifest: AssetBundleManifest;
  workspace: AssetRepoWorkspace;
  graph: SemanticGraph;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** 编译资产仓工作区为内存 bundle。显式构建步骤:工作区缺失直接抛错(fail-fast)。 */
export function compileAssetBundle(
  repoRoot: string,
  workspaceId: string,
  opts?: { bundleId?: string; now?: () => string },
): CompiledAssetBundle {
  const ws = loadAssetWorkspace(repoRoot, workspaceId);
  if (ws.warnings.some((w) => w.includes("工作区目录不存在"))) {
    throw new Error(`资产仓工作区不存在:${repoRoot}/workspaces/${workspaceId}`);
  }
  const graphEdges = buildSemanticGraph(ws).edges;
  let gitSha: string | undefined;
  try {
    const out = execSync("git rev-parse --short=8 HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{8}$/.test(out)) gitSha = out;
  } catch {
    /* 非 git 目录(如测试 fixture) */
  }
  const compiledAt = (opts?.now ?? (() => new Date().toISOString()))();
  const counts = {
    terms: ws.terms.length,
    classes: ws.classes.length,
    relations: ws.relations.length,
    actions: ws.actions.length,
    metrics: ws.metrics.length,
    playbooks: ws.playbooks.length,
    skills: ws.skills.length,
    knowledge: ws.knowledge.length,
    bindings: ws.bindings?.length ?? 0,
    graphEdges: graphEdges.length,
  };
  const bundleId =
    opts?.bundleId ??
    `${workspaceId}-${compiledAt.slice(0, 10)}-${sha256(JSON.stringify({ counts, gitSha, releaseId: ws.releaseId })).slice(0, 8)}`;
  const manifest: AssetBundleManifest = {
    bundleId,
    workspaceId,
    workspaceName: ws.name,
    releaseId: ws.releaseId,
    compiledAt,
    source: { root: repoRoot, gitSha },
    counts,
  };
  return { manifest, workspace: ws, graphEdges };
}

const MANIFEST = "manifest.json";
const ASSETS = "assets.json";
const GRAPH = "graph.json";
const CHECKSUMS = "checksums.sha256";
const BUNDLE_FILES = [MANIFEST, ASSETS, GRAPH];

/** 写盘:manifest.json / assets.json / graph.json / checksums.sha256(逐文件 sha256) */
export function writeAssetBundle(bundle: CompiledAssetBundle, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const manifestText = JSON.stringify(bundle.manifest, null, 1);
  // 快照中 root 是编译机本地路径,仅留作溯源;加载后以 bundle 目录为准
  const assetsText = JSON.stringify({ ...bundle.workspace, root: outDir }, null, 1);
  const graphText = JSON.stringify(bundle.graphEdges, null, 1);
  writeFileSync(join(outDir, MANIFEST), manifestText);
  writeFileSync(join(outDir, ASSETS), assetsText);
  writeFileSync(join(outDir, GRAPH), graphText);
  writeFileSync(
    join(outDir, CHECKSUMS),
    BUNDLE_FILES.map((f) => `${f}:${sha256(readFileSync(join(outDir, f)))}`).join("\n") + "\n",
  );
}

/** 加载 bundle(fail-closed):文件缺失、sha256 不符、清单计数与实际不符 → null + 告警。 */
export function loadAssetBundle(bundleDir: string): { bundle: LoadedAssetBundle | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!existsSync(bundleDir)) {
    return { bundle: null, warnings: [`bundle 目录不存在:${bundleDir}`] };
  }
  for (const f of [...BUNDLE_FILES, CHECKSUMS]) {
    if (!existsSync(`${bundleDir}/${f}`)) {
      return { bundle: null, warnings: [`bundle 缺少文件:${f}`] };
    }
  }
  // sha256 校验(checksums 行格式 "文件名:sha256")
  const checksumText = readFileSync(`${bundleDir}/${CHECKSUMS}`, "utf-8");
  for (const line of checksumText.trim().split("\n").filter(Boolean)) {
    const [file, expected] = line.split(":");
    if (!BUNDLE_FILES.includes(file!) || !expected) continue;
    const actual = sha256(readFileSync(`${bundleDir}/${file}`));
    if (actual !== expected) {
      return { bundle: null, warnings: [`checksum 校验失败:${file}(期望 ${expected?.slice(0, 12)}…,实际 ${actual.slice(0, 12)}…)`] };
    }
  }
  let manifest: AssetBundleManifest;
  let workspace: AssetRepoWorkspace;
  try {
    manifest = JSON.parse(readFileSync(`${bundleDir}/${MANIFEST}`, "utf-8"));
    workspace = JSON.parse(readFileSync(`${bundleDir}/${ASSETS}`, "utf-8"));
  } catch (e) {
    return { bundle: null, warnings: [`bundle JSON 解析失败:${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!manifest?.bundleId || !manifest?.counts || !workspace?.metrics) {
    return { bundle: null, warnings: ["bundle 结构不完整(manifest/workspace 缺字段)"] };
  }
  // 清单计数完整性:即使重算 checksums,内容与清单不符也拒绝
  const actual = {
    terms: workspace.terms?.length ?? 0,
    classes: workspace.classes?.length ?? 0,
    relations: workspace.relations?.length ?? 0,
    actions: workspace.actions?.length ?? 0,
    metrics: workspace.metrics.length,
    playbooks: workspace.playbooks?.length ?? 0,
    skills: workspace.skills?.length ?? 0,
    knowledge: workspace.knowledge?.length ?? 0,
    bindings: workspace.bindings?.length ?? 0,
  };
  for (const [k, v] of Object.entries(actual)) {
    if (manifest.counts[k as keyof typeof actual] !== v) {
      return { bundle: null, warnings: [`清单计数不符:${k} 清单=${manifest.counts[k as keyof typeof actual]} 实际=${v}`] };
    }
  }
  const graph = buildSemanticGraph(workspace);
  if (graph.edges.length !== manifest.counts.graphEdges) {
    return { bundle: null, warnings: [`图边数不符:清单=${manifest.counts.graphEdges} 实际=${graph.edges.length}`] };
  }
  return { bundle: { manifest, workspace, graph }, warnings };
}
