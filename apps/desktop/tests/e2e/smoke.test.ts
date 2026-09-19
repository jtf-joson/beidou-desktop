import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspace } from "../../src/main/workspace";
import { AgentService, type AgentEvent } from "../../src/main/agent/service";
import type { SrQueryResult } from "@beidou/core/src/services/starrocks";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../packages/beidou-core/test-fixtures/beidou", import.meta.url));

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "daw-e2e-"));
  mkdirSync(join(dir, "semantics", "import"), { recursive: true });
  const MAP: Record<string, string> = {
    "metrics.json": "metrics.sample.json",
    "details.json": "details.sample.json",
    "dimensions.json": "dimensions.sample.json",
    "lineage_summary.json": "lineage_summary.sample.json",
    "physical_tables.json": "physical_tables.sample.json",
  };
  for (const [canonical, fixture] of Object.entries(MAP)) {
    cpSync(join(FIXTURE_DIR, fixture), join(dir, "semantics", "import", canonical));
  }
  writeFileSync(
    join(dir, "config.yaml"),
    [
      "name: 冒烟测试空间",
      "guard:",
      "  max_row: 100",
      "  sensitive_columns: []",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "semantics", "glossary.yaml"),
    ["terms:", "  - term: 高速智驾", "    synonyms: [高速NOP]", "    metricRefs: [sum_highway_adas_odometer_days]", ""].join("\n"),
  );
  return dir;
}

describe("e2e 冒烟(mock 策略,无模型 key,SPEC S1.4)", () => {
  let events: AgentEvent[];
  let service: AgentService;

  beforeAll(() => {
    const wsDir = makeWorkspace();
    const ws = loadWorkspace(wsDir);
    expect(ws.warnings.join("\n")).not.toContain("缺少 semantics/import");
    const rows: SrQueryResult = { rows: [{ metric_value: 42 }], columns: ["metric_value"], rowCount: 1, truncated: false };
    service = new AgentService(ws, {
      starrocksQuery: async () => ({ ok: true, value: rows }),
    });
    events = [];
  });

  it("指标问题:检索→路由→口径编译→执行→带证据回答", async () => {
    await service.ask("s1", "高速智驾天数最近一个月是多少", (e) => events.push(e));
    const answer = events.filter((e) => e.type === "assistant").at(-1)?.text ?? "";
    expect(answer).toContain("高速智驾天数");
    expect(answer).toContain("42");
    expect(events.some((e) => e.type === "tool" && e.name === "search_semantics")).toBe(true);
    expect(events.some((e) => e.type === "tool" && e.name === "query_metrics")).toBe(true);
    const ev = events.find((e) => e.type === "evidence") as { items: Array<{ kind: string; caliber?: string; sql?: string; lineage?: string[] }> } | undefined;
    const metricEvidence = ev?.items.find((i) => i.kind === "metric_query");
    expect(metricEvidence?.caliber).toBeTruthy();
    expect(metricEvidence?.sql).toContain("count(");
    expect(metricEvidence?.lineage?.length).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("未知问题:走澄清(不猜)", async () => {
    const local: AgentEvent[] = [];
    await service.ask("s2", "完全不存在的一个概念xyzabc", (e) => local.push(e));
    const answer = local.filter((e) => e.type === "assistant").at(-1)?.text ?? "";
    expect(answer).toContain("补充");
    expect(local.some((e) => e.type === "tool" && e.name === "clarify")).toBe(true);
  });

  it("审计与工作区文件可回读(workspace 目录是权威源)", () => {
    const ws2 = loadWorkspace(makeWorkspace());
    expect(ws2.assets.metrics.length).toBeGreaterThan(0);
    expect(ws2.store.search("高速智驾")[0]?.kind).toBe("metric");
  });
});

describe("e2e mock 演示数据模式(未配 StarRocks,默认启用)", () => {
  it("全链路出数且诚实标注 mock", async () => {
    const wsDir = makeWorkspace();
    // makeWorkspace 的 config.yaml 不含 starrocks → mockActive = true
    const ws = loadWorkspace(wsDir);
    const service = new AgentService(ws, {
      // 不注入 starrocksQuery —— 模拟主进程未配置场景由 buildAgentService 决定;
      // 这里直接用 mock 连接器组装,等价于 main 的 mockDataActive 分支
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
        return queryStarRocks(createMockStarRocks(), { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
      dataSource: "mock",
    });
    const local: AgentEvent[] = [];
    await service.ask("mock-1", "高速智驾天数最近一个月是多少", (e) => local.push(e));
    const answer = local.filter((e) => e.type === "assistant").at(-1)?.text ?? "";
    expect(answer).toMatch(/\d+/); // 出数了
    expect(answer).toContain("演示"); // 诚实标注
    const ev = local.find((e) => e.type === "evidence") as { items: Array<{ mock?: boolean; kind: string }> } | undefined;
    const metricEvidence = ev?.items.find((i) => i.kind === "metric_query");
    expect(metricEvidence?.mock).toBe(true);
  });

  it("确定性:同一问题两次结果一致", async () => {
    const ws = loadWorkspace(makeWorkspace());
    const mkQuery = async () => {
      const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
      const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
      const mock = createMockStarRocks({ now: () => new Date("2026-09-18T08:00:00Z") });
      return (sql: string) => queryStarRocks(mock, { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
    };
    const service = new AgentService(ws, { starrocksQuery: await mkQuery(), dataSource: "mock" });
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    await service.ask("d1", "高速智驾天数", (e) => a.push(e));
    await service.ask("d2", "高速智驾天数", (e) => b.push(e));
    const ansA = a.filter((e) => e.type === "assistant").at(-1)?.text;
    const ansB = b.filter((e) => e.type === "assistant").at(-1)?.text;
    expect(ansA).toBe(ansB);
  });
});

describe("e2e 跨数据集维度下钻(mock 数据,真实编译能力)", () => {
  it("按车型(config_level)看高速智驾天数 → JOIN 维表 SQL + 分组结果", async () => {
    const ws = loadWorkspace(makeWorkspace());
    const service = new AgentService(ws, {
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
        return queryStarRocks(createMockStarRocks({ now: () => new Date("2026-09-18T08:00:00Z") }), { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
      dataSource: "mock",
    });
    // 直接走工具层验证核心能力(LLM 编排路径已被 llm-smoke 覆盖)
    const { createTools } = await import("@beidou/core/src/tools/tools");
    const tools = createTools((service as unknown as { buildToolContext(s: string): never }).buildToolContext?.("dim-e2e") ?? (service as never));
    const q = await tools.query_metrics({
      metricName: "sum_highway_adas_odometer_days",
      dims: ["dim_vehicle_property_df_config_level"],
      timeRange: { start: "2026-08-01", end: "2026-08-31" },
    });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.evidence[0]?.sql).toContain("LEFT JOIN default_catalog.dim.dim_vehicle_property_df");
    expect(q.evidence[0]?.sql).toContain("GROUP BY d0.config_level");
  });
});

describe("e2e 智能诊断 + 知识库/Playbook(mock 数据,真实能力)", () => {
  it("diagnose_metric:异动归因结构化输出", async () => {
    const wsDir = makeWorkspace();
    const ws = loadWorkspace(wsDir);
    const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
    const mock = createMockStarRocks({ now: () => new Date("2026-09-18T08:00:00Z") });
    const service = new AgentService(ws, {
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        return queryStarRocks(mock, { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
      dataSource: "mock",
    });
    const { createTools } = await import("@beidou/core/src/tools/tools");
    const tools = createTools((service as unknown as { buildToolContext(s: string): never }).buildToolContext?.("diag-e2e") ?? (service as never));
    const r = await tools.diagnose_metric({
      metricName: "sum_highway_adas_odometer_days",
      timeRange: { start: "2026-08-01", end: "2026-08-31" },
      dims: ["dim_vehicle_property_df_config_level"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as { totals: unknown; anomaly: { anomaly: boolean }; attributions: Array<{ dim: string; top: unknown[] }> };
    expect(parsed.totals).toHaveProperty("current");
    expect(parsed.anomaly).toHaveProperty("direction");
    expect(parsed.attributions[0]!.dim).toBe("dim_vehicle_property_df_config_level");
    expect(parsed.attributions[0]!.top.length).toBeGreaterThan(0);
  });

  it("search_knowledge / read_playbook:命中与未命中", async () => {
    const wsDir = makeWorkspace();
    mkdirSync(join(wsDir, "knowledge"), { recursive: true });
    mkdirSync(join(wsDir, "playbooks"), { recursive: true });
    writeFileSync(join(wsDir, "knowledge", "口径说明.md"), "# 口径说明\n高速智驾天数按 NOA 开启计。交付放量会影响激活。");
    writeFileSync(join(wsDir, "playbooks", "归因.md"), "# 归因 SOP\n1. 跑诊断 2. 查知识 3. 出报告");
    const ws = loadWorkspace(wsDir);
    const { createTools } = await import("@beidou/core/src/tools/tools");
    const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
    const mock = createMockStarRocks();
    const service = new AgentService(ws, {
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        return queryStarRocks(mock, { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
    });
    const tools = createTools((service as unknown as { buildToolContext(s: string): never }).buildToolContext?.("kb-e2e") ?? (service as never));
    const k = await tools.search_knowledge({ query: "交付 激活" });
    expect(k.ok).toBe(true);
    expect(JSON.parse(k.text).hits[0]?.name).toBe("口径说明");
    const pb = await tools.read_playbook({ name: "归因" });
    expect(pb.ok).toBe(true);
    expect(pb.text).toContain("归因 SOP");
    const miss = await tools.read_playbook({ name: "不存在" });
    expect(miss.ok).toBe(false);
  });
});

describe("e2e 实体/业务模型进检索与诊断(v0.6)", () => {
  it("search_semantics 命中业务模型(带关注维度)", async () => {
    const wsDir = makeWorkspace();
    writeFileSync(join(wsDir, "semantics", "entities.yaml"), [
      "entities:",
      "  - name: 车辆",
      "    dataset: dim_vehicle_property_df",
      "    key: vin",
      "    attributes: [config_level]",
      "businessModels:",
      "  - name: 智驾活跃",
      "    entities: [车辆]",
      "    metrics: [sum_highway_adas_odometer_days]",
      "    dimensions: [dim_vehicle_property_df_config_level]",
    ].join("\n"));
    const ws = loadWorkspace(wsDir);
    const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
    const mock = createMockStarRocks({ now: () => new Date("2026-09-18T08:00:00Z") });
    const service = new AgentService(ws, {
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        return queryStarRocks(mock, { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
    });
    const { createTools } = await import("@beidou/core/src/tools/tools");
    const tools = createTools((service as unknown as { buildToolContext(s: string): never }).buildToolContext?.("ent-e2e") ?? (service as never));
    const r = await tools.search_semantics({ query: "车辆" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hits = JSON.parse(r.text).hits as Array<{ kind: string; id: string; dimensions?: string[] }>;
    expect(hits.some((h) => h.kind === "entity" && h.id === "车辆")).toBe(true);
  });

  it("diagnose_metric 无显式 dims 时用业务模型声明的关注维度", async () => {
    const wsDir = makeWorkspace();
    writeFileSync(join(wsDir, "semantics", "entities.yaml"), [
      "entities: []",
      "businessModels:",
      "  - name: 智驾活跃",
      "    metrics: [sum_highway_adas_odometer_days]",
      "    dimensions: [dim_vehicle_property_df_config_level, dim_vehicle_property_df_veh_series_no]",
    ].join("\n"));
    const ws = loadWorkspace(wsDir);
    const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
    const mock = createMockStarRocks({ now: () => new Date("2026-09-18T08:00:00Z") });
    const service = new AgentService(ws, {
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        return queryStarRocks(mock, { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
    });
    const { createTools } = await import("@beidou/core/src/tools/tools");
    const tools = createTools((service as unknown as { buildToolContext(s: string): never }).buildToolContext?.("dim-sel-e2e") ?? (service as never));
    const r = await tools.diagnose_metric({
      metricName: "sum_highway_adas_odometer_days",
      timeRange: { start: "2026-08-01", end: "2026-08-31" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as { attributions: Array<{ dim: string }> };
    const dims = parsed.attributions.map((a) => a.dim);
    expect(dims).toContain("dim_vehicle_property_df_config_level");
    expect(dims).toContain("dim_vehicle_property_df_veh_series_no");
  });
});

describe("e2e Phase 2:ontology 集成", () => {
  it("list_ontology 返回子域+class+action 结构", async () => {
    const wsDir = makeWorkspace();
    writeFileSync(join(wsDir, "semantics", "ontology.yaml"), [
      "schemaVersion: 1",
      "version: 0.1.0",
      "domain:",
      "  id: service",
      "  name: 服务",
      "  subdomains:",
      "    - { id: store-ops, name: 门店经营, status: active, topics: [销售], owners: [] }",
      "classes:",
      "  - id: Store",
      "    name: 门店",
      "    subdomain: store-ops",
      "    topic: 销售",
      "    key: store_code",
      "    properties:",
      "      - { id: store_code, name: 门店编码, datatype: string, required: true }",
      "actions:",
      "  - id: analyze_sales",
      "    name: 销售分析",
      "    subdomain: store-ops",
      "    subject: Store",
      "    metrics: [store_sales_amt]",
    ].join("\n"));
    const ws = loadWorkspace(wsDir);
    const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
    const mock = createMockStarRocks();
    const service = new AgentService(ws, {
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        return queryStarRocks(mock, { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
    });
    const { createTools } = await import("@beidou/core/src/tools/tools");
    const tools = createTools((service as unknown as { buildToolContext(s: string): never }).buildToolContext?.("onto-e2e") ?? (service as never));
    const r = await tools.list_ontology({ subdomain: "store-ops" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as { subdomains: Array<{ subdomain: string; classes: Array<{ id: string }>; actions: Array<{ id: string }> }> };
    expect(parsed.subdomains[0]!.subdomain).toBe("store-ops");
    expect(parsed.subdomains[0]!.classes[0]!.id).toBe("Store");
    expect(parsed.subdomains[0]!.actions[0]!.id).toBe("analyze_sales");
  });

  it("search_semantics 命中本体 class(名称/属性)", async () => {
    const wsDir = makeWorkspace();
    writeFileSync(join(wsDir, "semantics", "ontology.yaml"), [
      "schemaVersion: 1",
      "version: 0.1.0",
      "domain: { id: s, name: S, subdomains: [{ id: a, name: A, status: active, topics: [] }] }",
      "classes:",
      "  - id: Store",
      "    name: 门店",
      "    subdomain: a",
      "    properties: [{ id: store_code, name: 门店编码, datatype: string }]",
    ].join("\n"));
    const ws = loadWorkspace(wsDir);
    const { createMockStarRocks } = await import("@beidou/core/src/services/mock-starrocks");
    const mock = createMockStarRocks();
    const service = new AgentService(ws, {
      starrocksQuery: async (sql) => {
        const { queryStarRocks } = await import("@beidou/core/src/services/starrocks");
        return queryStarRocks(mock, { host: "", port: 9030, user: "", password: "", maxRows: 100 }, sql);
      },
    });
    const { createTools } = await import("@beidou/core/src/tools/tools");
    const tools = createTools((service as unknown as { buildToolContext(s: string): never }).buildToolContext?.("onto-search") ?? (service as never));
    const r = await tools.search_semantics({ query: "门店" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hits = JSON.parse(r.text).hits as Array<{ id: string; why: string }>;
    const storeHit = hits.find((h) => h.id === "Store");
    expect(storeHit).toBeDefined();
    expect(storeHit!.why).toContain("本体 class");
  });
});
