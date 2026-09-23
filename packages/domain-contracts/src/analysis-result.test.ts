import { describe, expect, it } from "vitest";
import type { AnalysisResultEnvelope } from "./analysis-result";

describe("analysis result contract", () => {
  it("represents a chart without requiring natural-language parsing", () => {
    const envelope: AnalysisResultEnvelope = {
      version: 1,
      sessionId: "session-1",
      resultId: "result-1",
      generatedAt: "2026-09-21T00:00:00.000Z",
      results: [{
        type: "line",
        title: "近 7 日投诉率",
        labels: ["一", "二"],
        series: [{ name: "投诉率", values: [1.2, 1.5] }],
        actions: ["drilldown", "explain", "report"],
      }],
    };

    expect(envelope.results[0]?.type).toBe("line");
    expect(envelope.results[0]?.series[0]?.values).toEqual([1.2, 1.5]);
  });
});
