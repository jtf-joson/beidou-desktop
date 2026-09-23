import { describe, expect, it } from "vitest";
import { createAnyMetricsClient } from "./anymetrics";

const okEnvelope = (data: unknown) => JSON.stringify({ code: 200, message: "success", data });

describe("createAnyMetricsClient", () => {
  it("listMetrics 携带三 header + 分页参数,解析信封", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = createAnyMetricsClient(
      { baseUrl: "https://anymetrics.example", tenantId: "tn_1", authValue: "u1" },
      {
        fetchFn: (async (url: any, init: any) => {
          calls.push({ url: String(url), headers: init.headers });
          return new Response(okEnvelope({ data: [{ metricName: "m1" }], total: 1, hasNext: false }));
        }) as typeof fetch,
      },
    );
    const r = await client.listMetrics({ page: 1, pageSize: 200 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.metrics).toHaveLength(1);
      expect(r.value.hasNext).toBe(false);
    }
    expect(calls[0]!.url).toContain("/anymetrics/api/v1/metrics/list?pageNumber=1&pageSize=200");
    expect(calls[0]!.headers["tenant-id"]).toBe("tn_1");
    expect(calls[0]!.headers["auth-type"]).toBe("UID");
    expect(calls[0]!.headers["auth-value"]).toBe("u1");
  });

  it("metricDetail 数组参数按重复 key 编码(每批 ≤50)", async () => {
    let captured = "";
    const client = createAnyMetricsClient(
      { baseUrl: "https://anymetrics.example", tenantId: "tn_1", authValue: "u1" },
      {
        fetchFn: (async (url: any) => {
          captured = String(url);
          return new Response(okEnvelope([{ metricName: "a" }, { metricName: "b" }]));
        }) as typeof fetch,
      },
    );
    const r = await client.metricDetail(["a", "b"]);
    expect(r.ok).toBe(true);
    expect(captured).toContain("metricNames=a&metricNames=b");
  });

  it("业务错误信封(code≠200)→ fail-closed", async () => {
    const client = createAnyMetricsClient(
      { baseUrl: "https://x.example", tenantId: "t", authValue: "u" },
      { fetchFn: (async () => new Response(JSON.stringify({ code: 403, errorMsg: "no permission" }))) as typeof fetch },
    );
    const r = await client.listMetrics({ page: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("no permission");
  });

  it("网络 500 自动重试,重试成功后正常返回", async () => {
    let n = 0;
    const client = createAnyMetricsClient(
      { baseUrl: "https://x.example", tenantId: "t", authValue: "u" },
      {
        fetchFn: (async () => {
          n++;
          if (n < 3) return new Response("boom", { status: 500 });
          return new Response(okEnvelope({ data: [], total: 0, hasNext: false }));
        }) as typeof fetch,
        delayFn: async () => {},
      },
    );
    const r = await client.listMetrics({ page: 1 });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("连续失败超过重试上限 → 错误", async () => {
    let n = 0;
    const client = createAnyMetricsClient(
      { baseUrl: "https://x.example", tenantId: "t", authValue: "u" },
      {
        fetchFn: (async () => {
          n++;
          return new Response("boom", { status: 500 });
        }) as typeof fetch,
        delayFn: async () => {},
      },
    );
    const r = await client.listMetrics({ page: 1 });
    expect(r.ok).toBe(false);
    expect(n).toBe(3);
  });

  it("queryMetrics 调用语义层并把列式响应转换为行式数据", async () => {
    let captured = "";
    const client = createAnyMetricsClient(
      { baseUrl: "https://anymetrics.example", semanticBaseUrl: "https://semantic.example", tenantId: "tn_1", authValue: "u1" },
      { fetchFn: (async (url: any, init: any) => {
        captured = `${String(url)} ${String(init.body)}`;
        return new Response(okEnvelope({ table: { columns: { metric_time__month: [{ value: "2026-01-01" }], sales: [{ value: 12 }] } } }));
      }) as typeof fetch },
    );
    const r = await client.queryMetrics({ metricName: "sales", dimensions: ["metric_time__month"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rows).toEqual([{ "metric_time__month": "2026-01-01", sales: 12 }]);
    expect(captured).toContain("https://semantic.example/semantic/api/v1.1/metrics/query");
    expect(captured).toContain('"metrics":["sales"]');
  });
});
