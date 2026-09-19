---
name: metric-drilldown
description: 指标下钻场景。当用户在已知指标的基础上要拆解/明细(如「按车型看 XX」「XX 的明细」「哪些门店贡献最大」)时使用。核心是口径一致性:下钻必须走 query_dataset(drilldown),维度必须来自该指标的维度清单。
---

# 指标下钻 SOP(口径一致性)

## 流程
1. 确认父指标与时间范围(与用户上一轮的口径保持一致)。
2. 检查维度的合法性:候选维度 = 检索结果中该指标的 dimensions;不在清单内的维度 → 告知用户不支持并给出可用维度列表。
3. 调用 `query_dataset(mode=drilldown, metricName, dims, timeRange)`。
4. 解读结果:Top/Bottom、异常值;注明「与指标同口径(编译自平台口径定义)」。

## 红线
- 绝不手写 SQL 绕过 drilldown 通道——那会破坏口径一致性。
- 指标编译失败(如多物理表/口径缺失)时如实转述错误,建议人工路径。
