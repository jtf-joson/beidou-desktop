/**
 * 黄金问题回归(确定性层,不调 LLM):验证「装载→索引→检索→图扩展→知识检索」
 * 整条链路能否解析评测集断言的资产。跑真实资产仓:
 *   BEIDOU_ASSET_REPO=/Users/jiatianfu/databuddy/beidou-workspace npx vitest run
 * 行为层回归(Tool Plan/Clarify/拒答)属 LLM 层,由 beidou-sdk headless 阶段承接。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { loadWorkspace, type LoadedWorkspace } from "./workspace";
import { loadAssetWorkspace, type AssetRepoWorkspace } from "@beidou/ontology-schema/src/index.ts";
import { searchKnowledge } from "@beidou/core/src/tools/knowledge.ts";
import { decideRoute } from "@beidou/core/src/router/policy.ts";

const REPO = process.env.BEIDOU_ASSET_REPO?.replace(/\/$/, "");
const WS_ID = "aftersale-service";

interface EvalCase {
  id: string;
  question?: string;
  expects?: { tools?: string[]; assets?: string[]; candidates?: string[]; policy?: string };
}

function loadEvalFile(repo: string, file: string): EvalCase[] {
  const path = join(repo, "workspaces", WS_ID, "evaluations", file);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text) as { cases?: EvalCase[] } | null;
  return parsed?.cases ?? [];
}

function setup() {
  const spaceDir = mkdtempSync(join(tmpdir(), "eval-golden-"));
  mkdirSync(spaceDir, { recursive: true });
  writeFileSync(join(spaceDir, "config.yaml"), `asset_repo:\n  root: ${REPO}\n  workspace: ${WS_ID}\n`);
  const ws = loadWorkspace(spaceDir);
  const repo = loadAssetWorkspace(REPO!, WS_ID);
  return { ws, repo, cleanup: () => rmSync(spaceDir, { recursive: true, force: true }) };
}

/** 注册表存在性(评测断言的资产 ID 必须真实存在) */
function registryHas(repo: AssetRepoWorkspace, id: string): boolean {
  if (id.startsWith("term.")) return repo.terms.some((t) => t.id === id);
  if (id.startsWith("class.")) return repo.classes.some((c) => c.id === id);
  if (id.startsWith("relation.")) return repo.relations.some((r) => r.id === id);
  if (id.startsWith("metric.")) return repo.metrics.some((m) => m.id === id);
  if (id.startsWith("playbook.")) return repo.playbooks.some((p) => p.id === id);
  if (id.startsWith("skill.")) return repo.skills.some((s) => s.id === id);
  if (id.startsWith("policy.")) return repo.policies.some((p) => p.id === id);
  if (id.startsWith("acl.")) return repo.acls.some((a) => a.id === id);
  if (id.startsWith("output-schema.")) return repo.outputSchemas.some((o) => o.id === id);
  if (id.startsWith("dimension.")) return repo.metrics.some((m) => (m.dimensions ?? []).includes(id));
  if (id.startsWith("knowledge.")) return repo.knowledge.some((p) => p.content.includes(`id: ${id}`));
  return false;
}

/** 检索链路可解析性:按资产类型走对应通道(检索命中/图扩展/随指标携带/知识命中/注册表) */
function resolveAsset(id: string, question: string, ws: LoadedWorkspace, repo: AssetRepoWorkspace): { ok: boolean; how: string } {
  const hits = ws.store.search(question, { limit: 10 });
  const metricById = new Map(ws.assets.metrics.map((m) => [m.code ?? "", m]));

  if (id.startsWith("metric.")) {
    const mirror = metricById.get(id);
    if (!mirror) return { ok: false, how: "指标未装载" };
    const rank = hits.findIndex((h) => h.kind === "metric" && h.id === mirror.metricName);
    if (rank >= 0) return { ok: true, how: `检索命中 #${rank + 1}` };
    const seeds = hits.slice(0, 3).map((h) => {
      if (h.kind === "metric") return ws.store.getMetric(h.id)?.code;
      if (h.kind === "entity" || h.kind === "model") return h.id;
      return undefined;
    }).filter((x): x is string => !!x);
    if (ws.graph?.expand(seeds, 2).includes(id)) return { ok: true, how: "图扩展可达" };
    return { ok: false, how: `未命中(top10:${hits.slice(0, 3).map((h) => h.displayName ?? h.id).join("/")})` };
  }
  if (id.startsWith("term.")) {
    const term = repo.terms.find((t) => t.id === id);
    if (!term) return { ok: false, how: "术语不存在" };
    return hits.some((h) => h.kind === "term" && h.id === term.name)
      ? { ok: true, how: "术语命中" }
      : { ok: false, how: `术语「${term.name}」未命中` };
  }
  if (id.startsWith("dimension.")) {
    const carrier = hits.find((h) => h.kind === "metric" && (ws.store.getMetric(h.id)?.dimensions ?? []).includes(id));
    return carrier ? { ok: true, how: `随 ${carrier.displayName} 命中` } : { ok: false, how: "无携带指标命中" };
  }
  if (id.startsWith("knowledge.")) {
    const page = repo.knowledge.find((p) => p.content.includes(`id: ${id}`));
    if (!page) return { ok: false, how: "知识页不存在" };
    const kHits = searchKnowledge(ws.knowledge, question);
    return kHits.some((k) => k.name === page.name)
      ? { ok: true, how: "知识检索命中" }
      : { ok: false, how: `未命中(top:${kHits.slice(0, 2).map((k) => k.name).join("/")})` };
  }
  // 本体关系/类:注册表 + 本体装载双查
  if (id.startsWith("relation.")) {
    return repo.relations.some((r) => r.id === id) && ws.ontology.relations.some((r) => r.id === id)
      ? { ok: true, how: "注册表+本体" } : { ok: false, how: "关系缺失" };
  }
  if (id.startsWith("class.")) {
    return repo.classes.some((c) => c.id === id) && ws.ontology.classes.some((c) => c.id === id)
      ? { ok: true, how: "注册表+本体" } : { ok: false, how: "类缺失" };
  }
  // playbook/skill/output-schema/policy:装载级(存在即可;检索行为属 LLM 层)
  if (registryHas(repo, id)) return { ok: true, how: "注册表" };
  return { ok: false, how: "注册表缺失" };
}

describe("黄金问题回归(检索链路 × 评测集,确定性)", () => {
  it.skipIf(!REPO || !existsSync(join(REPO!, "workspaces", WS_ID, "evaluations", "golden-questions.yaml")))("真实评测集:黄金问题断言的资产全部可解析", () => {
    const { ws, repo, cleanup } = setup();
    try {
      const cases = loadEvalFile(REPO!, "golden-questions.yaml");
      expect(cases).toHaveLength(20);
      const failures: string[] = [];
      for (const c of cases) {
        for (const asset of c.expects?.assets ?? []) {
          const r = resolveAsset(asset, c.question ?? "", ws, repo);
          if (!r.ok) failures.push(`${c.id} ${asset}:${r.how}`);
        }
      }
      expect(failures, `黄金问题检索失败 ${failures.length} 处:\n  ${failures.join("\n  ")}`).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it.skipIf(!REPO || !existsSync(join(REPO!, "workspaces", WS_ID, "evaluations", "golden-questions.yaml")))("真实评测集:黄金问题的工具期望可由语义检索支撑", () => {
    const { ws, cleanup } = setup();
    try {
      const cases = loadEvalFile(REPO!, "golden-questions.yaml");
      const knownTools = new Set([
        "search_semantics", "query_metrics", "query_dataset", "clarify", "diagnose_metric",
        "trace_lineage", "search_knowledge", "read_playbook", "list_ontology",
      ]);
      const failures: string[] = [];
      for (const c of cases) {
        const expectedTools = c.expects?.tools ?? [];
        for (const tool of expectedTools) {
          if (!knownTools.has(tool)) failures.push(`${c.id}:未知工具 ${tool}`);
        }
        if (!expectedTools.includes("query_metrics")) continue;
        const hits = ws.store.search(c.question ?? "", { limit: 10 });
        // 多步骤报告类问题可能先命中 Skill/Playbook，再由 Agent 选择指标；
        // 只有问题本身出现明确指标候选时，才对首跳 query_metrics 做强断言。
        if (!hits.some((h) => h.kind === "metric" && h.score >= 40)) continue;
        const route = decideRoute({
          hits,
          config: { metricScoreThreshold: 50 },
          // 这里验证语义决策本身;在线接口是否可用由运行时配置决定。
          metricOnline: true,
        });
        if (route.route !== "query_metrics") {
          failures.push(`${c.id}:期望 query_metrics,实际 ${route.route};top=${hits.slice(0, 3).map((h) => `${h.kind}:${h.id}:${Math.round(h.score)}:${h.why}`).join(",")}`);
        }
      }
      expect(failures, `工具路由回归失败 ${failures.length} 处:\n  ${failures.join("\n  ")}`).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it.skipIf(!REPO || !existsSync(join(REPO!, "workspaces", WS_ID, "evaluations", "ambiguity-questions.yaml")))("真实评测集:歧义问题候选资产全部存在(注册表)", () => {
    const { repo, cleanup } = setup();
    try {
      const cases = loadEvalFile(REPO!, "ambiguity-questions.yaml");
      expect(cases).toHaveLength(10);
      const missing: string[] = [];
      for (const c of cases) {
        for (const id of c.expects?.candidates ?? []) {
          if (!registryHas(repo, id)) missing.push(`${c.id}:${id}`);
        }
      }
      expect(missing).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it.skipIf(!REPO || !existsSync(join(REPO!, "workspaces", WS_ID, "evaluations", "permission-questions.yaml")))("真实评测集:权限问题引用的策略全部存在(注册表)", () => {
    const { repo, cleanup } = setup();
    try {
      const cases = loadEvalFile(REPO!, "permission-questions.yaml");
      expect(cases).toHaveLength(10);
      const missing: string[] = [];
      for (const c of cases) {
        const policy = c.expects?.policy;
        if (policy && !registryHas(repo, policy)) missing.push(`${c.id}:${policy}`);
      }
      expect(missing).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
