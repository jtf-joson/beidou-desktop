/**
 * Release Bundle(方案 §6 简化 JSON 形态)TDD:编译 → 写盘 → 校验加载 → 篡改检测。
 * bundle = 资产仓工作区的不可变快照(manifest + assets + graph + 逐文件 sha256),
 * 运行时加载即固定版本,不再回读 Git 工作区。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileAssetBundle, loadAssetBundle, writeAssetBundle } from "./asset-bundle";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

/** 最小资产仓 fixture(与五层结构一致) */
function buildRepo(): string {
  const mk = (rel: string) => mkdirSync(join(dir, rel), { recursive: true });
  const put = (rel: string, content: string) => writeFileSync(join(dir, rel), content);
  mk("repo/workspaces/mini/01-glossary/terms");
  mk("repo/workspaces/mini/02-ontology/classes");
  mk("repo/workspaces/mini/02-ontology/relations");
  mk("repo/workspaces/mini/03-metrics/contracts");
  mk("repo/workspaces/mini/bindings/metric-platform");
  mk("repo/workspaces/mini/knowledge/pages");
  put("repo/workspaces/mini/workspace.yaml", "id: mini\nname: 迷你域\n");
  put("repo/workspaces/mini/01-glossary/terms/t1.yaml", "id: term.m.x\nname: 投诉\nstatus: published\naliases: [客诉]\n");
  put("repo/workspaces/mini/02-ontology/classes/store.yaml", "id: class.m.store\nname: 门店\nstatus: published\nsubdomain: subdomain.m\n");
  put("repo/workspaces/mini/02-ontology/relations/r1.yaml", "id: relation.m.at\nname: 归属\nstatus: published\ndomain: class.m.store\nrange: class.m.city\n");
  put("repo/workspaces/mini/03-metrics/contracts/cr.yaml", [
    "id: metric.m.cr", "name: 门店投诉率", "status: published", "subject: class.m.store",
    "provider:", "  providerMetricId: store_cr",
  ].join("\n"));
  put("repo/workspaces/mini/bindings/metric-platform/cr.yaml", [
    "schemaVersion: 1", "id: binding.metric.m.cr", "status: published", "metricId: metric.m.cr",
    "provider:", "  providerMetricId: store_cr", "queryMode: metric-api",
  ].join("\n"));
  put("repo/workspaces/mini/knowledge/pages/note.md", "# 口径\n正文");
  return join(dir, "repo");
}

function buildAndWrite(): { bundleDir: string; bundleId: string } {
  const repo = buildRepo();
  const bundle = compileAssetBundle(repo, "mini", { bundleId: "mini-test-1" });
  const bundleDir = join(dir, "bundle-out");
  writeAssetBundle(bundle, bundleDir);
  return { bundleDir, bundleId: bundle.manifest.bundleId };
}

describe("compileAssetBundle", () => {
  it("编译:清单计数/图边/快照内容正确", () => {
    dir = mkdtempSync(join(tmpdir(), "bundle-"));
    const repo = buildRepo();
    const b = compileAssetBundle(repo, "mini", { bundleId: "mini-test-1" });
    expect(b.manifest).toMatchObject({
      bundleId: "mini-test-1",
      workspaceId: "mini",
      workspaceName: "迷你域",
      releaseId: null,
    });
    expect(b.manifest.counts).toMatchObject({ terms: 1, classes: 1, relations: 1, metrics: 1, knowledge: 1, bindings: 1, graphEdges: 2 });
    expect(b.workspace.metrics[0]).toMatchObject({ id: "metric.m.cr", provider: { providerMetricId: "store_cr" } });
    expect(b.graphEdges.map((e) => e.type).sort()).toEqual(["measuredBy", "relatesTo"]);
  });

  it("工作区不存在:抛错(显式构建步骤,fail-fast)", () => {
    dir = mkdtempSync(join(tmpdir(), "bundle-"));
    expect(() => compileAssetBundle(join(dir, "repo"), "missing")).toThrow(/不存在/);
  });
});

describe("writeAssetBundle / loadAssetBundle", () => {
  it("写盘→加载:内容一致,图可查询,校验通过", () => {
    dir = mkdtempSync(join(tmpdir(), "bundle-"));
    const { bundleDir, bundleId } = buildAndWrite();
    const r = loadAssetBundle(bundleDir);
    expect(r.warnings).toEqual([]);
    expect(r.bundle?.manifest.bundleId).toBe(bundleId);
    expect(r.bundle?.workspace.metrics).toHaveLength(1);
    expect(r.bundle?.manifest.counts.bindings).toBe(1);
    expect(r.bundle?.workspace.bindings[0]?.id).toBe("binding.metric.m.cr");
    expect(r.bundle?.workspace.knowledge[0]?.name).toBe("note");
    expect(r.bundle?.graph.neighbors("class.m.store", { types: ["measuredBy"], direction: "out" })).toHaveLength(1);
  });

  it("篡改 assets.json:sha 校验失败,fail-closed 返回 null", () => {
    dir = mkdtempSync(join(tmpdir(), "bundle-"));
    const { bundleDir } = buildAndWrite();
    const p = join(bundleDir, "assets.json");
    writeFileSync(p, readFileSync(p, "utf8").replace("门店投诉率", "被篡改的指标"));
    const r = loadAssetBundle(bundleDir);
    expect(r.bundle).toBeNull();
    expect(r.warnings.some((w) => w.includes("checksum"))).toBe(true);
  });

  it("缺 manifest.json:返回 null + 告警(不抛)", () => {
    dir = mkdtempSync(join(tmpdir(), "bundle-"));
    const { bundleDir } = buildAndWrite();
    rmSync(join(bundleDir, "manifest.json"));
    const r = loadAssetBundle(bundleDir);
    expect(r.bundle).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("重算校验和的清单篡改:计数完整性兜底捕获", () => {
    dir = mkdtempSync(join(tmpdir(), "bundle-"));
    const { bundleDir } = buildAndWrite();
    // 改 manifest 计数并重算其 sha(checksums 文件同步更新),完整性校验仍应拒绝
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    manifest.counts.metrics = 999;
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 1));
    const sha = createHash("sha256").update(readFileSync(join(bundleDir, "manifest.json"))).digest("hex");
    writeFileSync(join(bundleDir, "checksums.sha256"), `manifest.json:${sha}\n`);
    const r = loadAssetBundle(bundleDir);
    expect(r.bundle).toBeNull();
    expect(r.warnings.some((w) => w.includes("计数"))).toBe(true);
  });
});
