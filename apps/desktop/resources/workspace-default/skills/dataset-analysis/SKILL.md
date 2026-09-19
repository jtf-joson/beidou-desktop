---
name: dataset-analysis
description: 无指标明细分析场景。当问题没有对应指标、用户要看原始数据集/表的明细或做探索分析(如「看下 XX 表最近的数据」「XX 和 YY 有什么关系」)时使用。走 query_dataset(explore)结构化参数,表与列必须来自语义检索结果。
---

# 无指标明细分析 SOP

## 流程
1. `search_semantics` 找数据集/物理表;优先事实表(被指标引用多的)。
2. 明确输出列(selectColumns)、聚合(aggregates)、过滤(where);粒度必须聚合,不做全表拉取。
3. 调用 `query_dataset(mode=explore, table, selectColumns, aggregates?, where?, groupBy?, limit)`。
4. 结果解读 + 声明局限:「此分析未经指标平台口径认证,仅基于表结构」。

## 红线
- 表/列只能来自检索结果或语义资产页清单。
- 敏感列被护栏拒绝时,解释原因并建议申请权限。
- 明细不整段贴给用户:先聚合,超过 20 行建议导出。
