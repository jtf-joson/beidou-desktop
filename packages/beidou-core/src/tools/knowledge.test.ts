import { describe, expect, it } from "vitest";
import { searchKnowledge } from "./knowledge";

const docs = [
  {
    name: "智驾口径说明",
    content: `# 智驾业务口径

## 高速智驾天数
按当日在高速场景开启 NOA/LCC 并产生有效里程计 1 车天。
车型层级 Pro/Max/Ultra;Max 自 2026-06 标配高速 NOA。

## 城市智驾
按城市 NOA 激活计。`,
  },
  {
    name: "交付节奏",
    content: `# 交付与激活
2026-07 Max 车型交付放量,交付→激活转化率约 85%。新车激活集中在提车 7 天内。`,
  },
];

describe("searchKnowledge(标题/小节加权 + 段落级摘录)", () => {
  it("正文关键词命中,摘录定位到命中段落", () => {
    const r = searchKnowledge(docs, "交付放量");
    expect(r[0]?.name).toBe("交付节奏");
    expect(r[0]?.excerpt).toContain("交付放量");
    expect(r[0]?.excerpt.length).toBeLessThanOrEqual(400);
    expect(r[0]!.score).toBeGreaterThan(0);
  });

  it("标题命中加权:同词频下标题命中排前", () => {
    const r = searchKnowledge(docs, "高速智驾天数");
    expect(r[0]?.name).toBe("智驾口径说明");
    expect(r[0]?.matchedHeadings).toContain("高速智驾天数");
  });

  it("多词组合计分,无命中不返回", () => {
    const r = searchKnowledge(docs, "NOA 转化率");
    expect(r.length).toBeGreaterThan(0);
    expect(searchKnowledge(docs, "完全不存在的词xyz")).toEqual([]);
  });

  it("命中段落优先摘录(而不是开头 600 字)", () => {
    const r = searchKnowledge(docs, "城市 NOA");
    // 「城市智驾」小节在文档末尾,摘录应定位到它
    expect(r[0]?.excerpt).toContain("城市 NOA 激活");
  });

  it("空文档/空查询 → 空结果", () => {
    expect(searchKnowledge([], "x")).toEqual([]);
    expect(searchKnowledge(docs, "")).toEqual([]);
  });
});
