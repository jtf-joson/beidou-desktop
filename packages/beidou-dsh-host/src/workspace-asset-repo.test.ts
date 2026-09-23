/**
 * loadWorkspace × asset_repo 集成:空间 config.yaml 指向资产仓后,
 * 语义资产/本体/知识/Playbook 全部来自五层 YAML,检索链路(store)可用。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "./workspace";
import { compileAssetBundle, writeAssetBundle } from "./asset-bundle";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

const mk = (rel: string) => mkdirSync(join(dir, rel), { recursive: true });
const put = (rel: string, content: string) => writeFileSync(join(dir, rel), content);

/** 空间目录 + 迷你资产仓,返回空间目录路径 */
function buildSpace(assetRepoRoot?: string): string {
  mk("space");
  mk("repo/workspaces/mini/01-glossary/terms");
  mk("repo/workspaces/mini/02-ontology/classes");
  mk("repo/workspaces/mini/02-ontology/relations");
  mk("repo/workspaces/mini/03-metrics/contracts");
  mk("repo/workspaces/mini/04-playbooks/playbooks");
  mk("repo/workspaces/mini/knowledge/pages");

  put("repo/workspaces/mini/workspace.yaml", "id: mini\nname: 迷你域\n");
  put("repo/workspaces/mini/01-glossary/terms/t1.yaml", [
    "id: term.m.complaint", "name: 投诉", "status: published",
    "definition: 客户投诉", "aliases: [客诉]",
  ].join("\n"));
  put("repo/workspaces/mini/02-ontology/classes/store.yaml", [
    "id: class.m.store", "name: 门店", "status: published",
    "domain: domain.m", "subdomain: subdomain.m-ops", "key: store_code",
  ].join("\n"));
  put("repo/workspaces/mini/02-ontology/relations/r1.yaml", [
    "id: relation.m.at", "name: 门店归属城市", "status: published",
    "domain: class.m.store", "range: class.m.city", "cardinality: N:1",
  ].join("\n"));
  put("repo/workspaces/mini/03-metrics/contracts/cr.yaml", [
    "id: metric.m.complaint-rate", "name: 门店投诉率", "status: published",
    "definition: 投诉工单量/台次", "subject: class.m.store",
    "provider:", "  providerMetricId: store_complaint_rate",
    "owners: [u1]",
    "imported:", "  metricType: COMPOSITE",
  ].join("\n"));
  put("repo/workspaces/mini/04-playbooks/playbooks/pb.yaml", [
    "id: playbook.m.pb", "name: 投诉处理", "status: published",
    "steps:", "  - name: 确认", "    rule: 投诉率超阈值", "    metrics: [metric.m.complaint-rate]",
  ].join("\n"));
  mkdirSync(join(dir, "repo/workspaces/mini/04-playbooks/skills"), { recursive: true });
  put("repo/workspaces/mini/04-playbooks/skills/diag.yaml", [
    "id: skill.m.diag", "name: 投诉诊断", "status: published",
    "requires:", "  metrics: [metric.m.complaint-rate]", "  playbooks: [playbook.m.pb]",
  ].join("\n"));
  put("repo/workspaces/mini/knowledge/pages/note.md", "# 投诉口径\n正文");

  const repoRoot = assetRepoRoot ?? join(dir, "repo");
  put("space/config.yaml", `name: 资产仓空间\nasset_repo:\n  root: ${repoRoot}\n  workspace: mini\n`);
  return join(dir, "space");
}

describe("loadWorkspace(asset_repo 模式)", () => {
  it("语义资产/本体/知识/Playbook 来自资产仓,store 可检索", () => {
    dir = mkdtempSync(join(tmpdir(), "ws-repo-"));
    const w = loadWorkspace(buildSpace());

    expect(w.assets.metrics).toHaveLength(1);
    expect(w.assets.metrics[0]).toMatchObject({
      metricName: "store_complaint_rate",
      code: "metric.m.complaint-rate",
      displayName: "门店投诉率",
      type: "COMPOSITE",
    });
    expect(w.assets.glossary[0]).toMatchObject({ term: "投诉", synonyms: ["客诉"] });

    // 检索链路:中文名与术语别名都能命中
    expect(w.store.search("门店投诉率")[0]?.id).toBe("store_complaint_rate");
    expect(w.store.search("客诉").some((h) => h.kind === "term")).toBe(true);

    expect(w.ontology.classes[0]).toMatchObject({ id: "class.m.store", subdomain: "subdomain.m-ops" });
    expect(w.ontology.relations).toHaveLength(1);
    // 语义图:装载期物化隐含边(relatesTo/measuredBy/usesMetric/usesPlaybook)
    const edgeTypes = (w.graph?.edges ?? []).map((e) => e.type).sort();
    expect(edgeTypes).toEqual(["measuredBy", "relatesTo", "usesMetric", "usesMetric", "usesPlaybook"]);
    expect(w.graph?.neighbors("metric.m.complaint-rate").map((n) => n.other).sort())
      .toEqual(["class.m.store", "playbook.m.pb", "skill.m.diag"].sort());
    expect(w.knowledge.map((k) => k.name)).toEqual(["note"]);
    expect(w.playbooks[0]?.content).toContain("# 投诉处理");
    expect(w.semanticVersion).toMatch(/^mini@\d{4}-\d{2}-\d{2}$/); // 无 releaseId 且临时目录非 git → 日期兜底
  });

  it("相对 root 按空间目录解析;repo 缺工作区 → 告警 + 空资产不阻断", () => {
    dir = mkdtempSync(join(tmpdir(), "ws-repo-"));
    mk("alt-repo"); // 空仓
    mk("space");
    put("space/config.yaml", "asset_repo:\n  root: ../alt-repo\n  workspace: missing\n");
    const w = loadWorkspace(join(dir, "space"));
    expect(w.assets.metrics).toEqual([]);
    expect(w.warnings.some((x) => x.includes("[asset-repo]"))).toBe(true);
  });

  it("未配置 asset_repo 时走原 semantics/import 路径(行为不变)", () => {
    dir = mkdtempSync(join(tmpdir(), "ws-repo-"));
    mk("space");
    put("space/config.yaml", "name: 普通空间\n");
    const w = loadWorkspace(join(dir, "space"));
    expect(w.assets.metrics).toEqual([]);
    expect(w.warnings.some((x) => x.includes("semantics/import"))).toBe(true);
  });

  it("auto_pull 非 git 目录:告警降级,资产仍装载", () => {
    dir = mkdtempSync(join(tmpdir(), "ws-repo-"));
    const space = buildSpace(); // fixture 仓不是 git 仓库 → pull 必然失败
    put("space/config.yaml", `asset_repo:\n  root: ${join(dir, "repo")}\n  workspace: mini\n  auto_pull: true\n`);
    const w = loadWorkspace(space);
    expect(w.assets.metrics).toHaveLength(1); // fail-open,资产照常装载
    expect(w.warnings.some((x) => x.includes("auto_pull 失败"))).toBe(true);
  });

  it("asset_bundle 模式:不可变快照装载,semanticVersion=bundleId", () => {
    dir = mkdtempSync(join(tmpdir(), "ws-bundle-"));
    buildSpace();
    const bundle = compileAssetBundle(join(dir, "repo"), "mini", { bundleId: "mini-b1" });
    writeAssetBundle(bundle, join(dir, "bundle"));
    put("space/config.yaml", `asset_bundle: ${join(dir, "bundle")}\n`);
    const w = loadWorkspace(join(dir, "space"));
    expect(w.assets.metrics).toHaveLength(1);
    expect(w.semanticVersion).toBe("mini-b1"); // bundle 即版本,不查 git
    expect(w.assetSource).toBe("bundle");
    expect(w.assetBundleId).toBe("mini-b1");
    expect(w.ontology.classes[0]).toMatchObject({ id: "class.m.store" });
    expect(w.graph?.edges.length).toBeGreaterThanOrEqual(2);
    expect(w.knowledge.map((k) => k.name)).toEqual(["note"]);
    expect(w.playbooks[0]?.content).toContain("# 投诉处理");
  });

  it("坏 bundle(篡改)+ 配了 asset_repo → 告警并回退资产仓", () => {
    dir = mkdtempSync(join(tmpdir(), "ws-bundle-"));
    buildSpace();
    const bundle = compileAssetBundle(join(dir, "repo"), "mini", { bundleId: "mini-b2" });
    writeAssetBundle(bundle, join(dir, "bundle"));
    const p = join(dir, "bundle", "assets.json");
    writeFileSync(p, readFileSync(p, "utf8").replace("门店投诉率", "篡改"));
    put("space/config.yaml", `asset_bundle: ${join(dir, "bundle")}\nasset_repo:\n  root: ${join(dir, "repo")}\n  workspace: mini\n`);
    const w = loadWorkspace(join(dir, "space"));
    expect(w.warnings.some((x) => x.includes("[asset-bundle] checksum"))).toBe(true);
    expect(w.assets.metrics).toHaveLength(1); // 回退 repo
    expect(w.semanticVersion).toMatch(/^mini@\d{4}-\d{2}-\d{2}$/); // repo 模式版本
    expect(w.assetSource).toBe("asset-repo");
  });

  // 真实资产仓冒烟:BEIDOU_ASSET_REPO=/Users/jiatianfu/databuddy/beidou-workspace npx vitest run
  it.skipIf(!process.env.BEIDOU_ASSET_REPO)("真实资产仓:369 售后指标装载并可检索", () => {
    dir = mkdtempSync(join(tmpdir(), "ws-real-"));
    const space = buildSpace(process.env.BEIDOU_ASSET_REPO!.replace(/\/$/, ""));
    put("space/config.yaml", `asset_repo:\n  root: ${process.env.BEIDOU_ASSET_REPO}\n  workspace: aftersale-service\n`);
    const w = loadWorkspace(space);
    expect(w.assets.metrics).toHaveLength(369);
    expect(w.assets.metrics.filter((m) => m.status === "deprecated")).toHaveLength(39);
    expect(w.ontology.classes).toHaveLength(16);
    expect(w.ontology.relations).toHaveLength(17);
    // 语义图:17 条本体关系 + 369 条 measuredBy(全部指标度量 service-ticket)
    expect(w.graph?.edges).toHaveLength(17 + 369);
    expect(w.graph?.neighbors("class.bs.service-ticket", { types: ["measuredBy"], direction: "out" })).toHaveLength(369);
    expect(w.assets.glossary).toHaveLength(1); // NSS
    const hit = w.store.search("售后门店投诉率").find((h) => h.kind === "metric");
    expect(hit?.id).toBe("aftersale_store_complaint_rate");
    expect(hit?.displayName).toBe("售后门店投诉率");
    // 维度已回填:契约携带可用维度
    const cr = w.assets.metrics.find((m) => m.metricName === "aftersale_store_complaint_rate");
    expect((cr?.dimensions ?? []).length).toBeGreaterThan(0);
    expect(w.semanticVersion).toMatch(/^aftersale-service@[0-9a-f]{8}$/); // git sha
  });
});
