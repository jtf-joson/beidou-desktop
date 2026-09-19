/**
 * Mock 演示数据连接器(StarRocksDeps 兼容)。
 * 用途:未配置真实 StarRocks 时跑通「检索→路由→口径编译→护栏→执行→证据」全链路演示。
 * 原则:确定性(SQL 哈希种子,同问同答)、形态正确(按 SELECT/GROUP BY/LIMIT 生成)、
 * 诚实标注(由工具层在文本与证据上标记 mock,本模块只出数)。
 */
import { tokenize } from "../guard/sql-guard";
import type { StarRocksDeps, StarRocksConfig, SrConn } from "./starrocks";

// --- 确定性随机:xmur3 哈希 + mulberry32 ---
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ParsedShape {
  selectCols: string[];
  groupCols: string[];
  limit: number;
}

const parseShape = (sql: string): ParsedShape | null => {
  const toks = tokenize(sql);
  const words = toks.filter((t) => t.kind !== "punct").map((t) => t.v);
  const upper = (i: number) => (words[i] ?? "").toUpperCase();
  if (upper(0) !== "SELECT") return null;

  // SELECT 列:SELECT 与 FROM 之间,按逗号分段;每段取 AS 别名,无别名取最后一个词
  const fromTokIdx = toks.findIndex((t, i) => i > 0 && t.kind === "word" && t.v.toUpperCase() === "FROM");
  if (fromTokIdx <= 1) return null;
  const selectCols: string[] = [];
  let segment: string[] = [];
  const flushSegment = (): void => {
    if (segment.length === 0) return;
    const asIdx = segment.findIndex((w) => w.toUpperCase() === "AS");
    const name = asIdx >= 0 && asIdx + 1 < segment.length ? segment[asIdx + 1]! : segment[segment.length - 1]!;
    selectCols.push(name);
    segment = [];
  };
  for (let i = 1; i < fromTokIdx; i++) {
    const t = toks[i]!;
    if (t.kind === "punct" && t.v === ",") flushSegment();
    else if (t.kind !== "punct") segment.push(t.v);
  }
  flushSegment();

  // GROUP BY
  const groupCols: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.toUpperCase() === "GROUP" && (words[i + 1] ?? "").toUpperCase() === "BY") {
      let j = i + 2;
      while (j < words.length && !["ORDER", "LIMIT", "HAVING"].includes((words[j] ?? "").toUpperCase())) {
        groupCols.push(words[j]!);
        j++;
      }
    }
  }

  // LIMIT(最后一个)
  let limit = 10;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i]!.toUpperCase() === "LIMIT" && /^\d+$/.test(words[i + 1] ?? "")) {
      limit = parseInt(words[i + 1]!, 10);
      break;
    }
  }
  return { selectCols, groupCols, limit };
};

const isDateLike = (col: string): boolean => /(dt|date|day|time|month)/i.test(col);

const dateStr = (offsetDays: number, now: Date): string => {
  const d = new Date(now.getTime() - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
};

const aggValue = (col: string, rand: () => number): number => {
  const c = col.toLowerCase();
  if (c.startsWith("avg") || c.includes("rate") || c.includes("ratio")) return Math.round(rand() * 1000) / 10;
  if (c.startsWith("sum")) return Math.round(rand() * 1_000_000);
  return Math.max(1, Math.round(rand() * 100_000));
};

export function createMockStarRocks(opts: { now?: () => Date } = {}): StarRocksDeps {
  const now = opts.now ?? (() => new Date());
  return {
    connect: async (_config: StarRocksConfig): Promise<SrConn> => ({
      async query(sql: string) {
        const shape = parseShape(sql);
        if (!shape) {
          return { rows: [], fields: [] };
        }
        const seedFn = xmur3(sql);
        const rand = mulberry32(seedFn());
        const { selectCols, groupCols, limit } = shape;
        const grouped = groupCols.length > 0;
        const rowCount = grouped ? Math.min(Math.max(3, Math.floor(rand() * 8) + 3), Math.max(1, limit)) : 1;

        const rows: Array<Record<string, unknown>> = [];
        for (let r = 0; r < rowCount; r++) {
          const row: Record<string, unknown> = {};
          for (const col of groupCols) {
            row[col] = isDateLike(col) ? dateStr(r * Math.max(1, Math.floor(30 / rowCount)), now()) : `${col}-${r + 1}`;
          }
          for (const col of selectCols) {
            if (groupCols.includes(col)) continue;
            row[col] = aggValue(col, rand);
          }
          rows.push(row);
        }
        return { rows, fields: selectCols.map((name) => ({ name })) };
      },
      async end() {
        /* mock 无连接可关 */
      },
    }),
  };
}
