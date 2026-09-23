/**
 * 语义图(方案 §3.2 Runtime 图模型的本地轻量实现)。
 * 边在装载期由声明资产物化(隐含逻辑显式化),运行时只做邻居/可达查询,不做推理:
 *   relatesTo     类 ↔ 类(本体关系)/ 关系声明
 *   measuredBy    类 → 指标(metric.subject 自动生成)
 *   derivedFrom   指标 → 指标(derivation.baseMetric)
 *   usesMetric / usesPlaybook / usesKnowledge   Skill/Action/Playbook 的依赖声明
 * 层级传递(rollup 路径)需要关系上的 kind 字段(Phase A Schema 冻结项),暂不闭包。
 */
export type SemanticEdgeType =
  | "relatesTo"
  | "measuredBy"
  | "derivedFrom"
  | "usesMetric"
  | "usesPlaybook"
  | "usesKnowledge";

export interface SemanticGraphEdge {
  source: string;
  type: SemanticEdgeType;
  target: string;
}

/** 图来源(结构化输入;AssetRepoWorkspace 结构兼容,旧导入模式无图) */
export interface GraphSource {
  relations?: Array<{ id?: string; domain: string; range: string }>;
  metrics?: Array<{ id: string; subject?: string; derivation?: { baseMetric?: string } }>;
  skills?: Array<{ id: string; requires?: { metrics?: string[]; knowledge?: string[]; playbooks?: string[] } }>;
  actions?: Array<{ id: string; subject?: string; relatedMetrics?: string[]; playbooks?: string[] }>;
  playbooks?: Array<{ id: string; steps?: Array<{ metrics?: string[]; knowledge?: string[] }> }>;
}

export interface NeighborOptions {
  types?: SemanticEdgeType[];
  direction?: "out" | "in" | "both";
}

export interface SemanticGraph {
  edges: SemanticGraphEdge[];
  /** 一跳邻居(默认双向);返回对端节点与命中边 */
  neighbors(id: string, opts?: NeighborOptions): Array<{ edge: SemanticGraphEdge; other: string }>;
  /** 多跳可达节点(BFS,不含种子;影响面/检索扩展) */
  expand(ids: string[], depth?: number, opts?: NeighborOptions): string[];
}

export function buildSemanticGraph(src: GraphSource): SemanticGraph {
  const edges: SemanticGraphEdge[] = [];
  const push = (source: string, type: SemanticEdgeType, target: string) => {
    if (source && target) edges.push({ source, type, target });
  };

  for (const r of src.relations ?? []) push(r.domain, "relatesTo", r.range);
  for (const m of src.metrics ?? []) {
    if (m.subject) push(m.subject, "measuredBy", m.id);
    if (m.derivation?.baseMetric) push(m.id, "derivedFrom", m.derivation.baseMetric);
  }
  for (const s of src.skills ?? []) {
    for (const mid of s.requires?.metrics ?? []) push(s.id, "usesMetric", mid);
    for (const k of s.requires?.knowledge ?? []) push(s.id, "usesKnowledge", k);
    for (const p of s.requires?.playbooks ?? []) push(s.id, "usesPlaybook", p);
  }
  for (const a of src.actions ?? []) {
    for (const mid of a.relatedMetrics ?? []) push(a.id, "usesMetric", mid);
    for (const p of a.playbooks ?? []) push(a.id, "usesPlaybook", p);
  }
  for (const pb of src.playbooks ?? []) {
    for (const step of pb.steps ?? []) {
      for (const mid of step.metrics ?? []) push(pb.id, "usesMetric", mid);
      for (const k of step.knowledge ?? []) push(pb.id, "usesKnowledge", k);
    }
  }

  // 双向邻接表:出边记在 source,入边记在 target
  const adjacency = new Map<string, Array<{ edge: SemanticGraphEdge; other: string; dir: "out" | "in" }>>();
  for (const edge of edges) {
    const out = adjacency.get(edge.source) ?? [];
    out.push({ edge, other: edge.target, dir: "out" });
    adjacency.set(edge.source, out);
    const inn = adjacency.get(edge.target) ?? [];
    inn.push({ edge, other: edge.source, dir: "in" });
    adjacency.set(edge.target, inn);
  }

  const matches = (e: SemanticGraphEdge, opts?: NeighborOptions) =>
    !opts?.types || opts.types.includes(e.type);

  const neighbors = (id: string, opts?: NeighborOptions) =>
    (adjacency.get(id) ?? [])
      .filter(({ edge, dir }) => matches(edge, opts) && (opts?.direction ? dir === opts.direction || opts.direction === "both" : true))
      .map(({ edge, other }) => ({ edge, other }));

  const expand = (ids: string[], depth = 1, opts?: NeighborOptions): string[] => {
    const seeds = new Set(ids.filter(Boolean));
    const visited = new Set(seeds);
    const frontier = [...seeds];
    const found: string[] = [];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const { other } of neighbors(node, opts)) {
          if (visited.has(other)) continue;
          visited.add(other);
          found.push(other);
          next.push(other);
        }
      }
      frontier.length = 0;
      frontier.push(...next);
    }
    return found;
  };

  return { edges, neighbors, expand };
}
