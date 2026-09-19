/**
 * SQL 护栏(SPEC Q2.8 / ARCHITECTURE 2.3)。
 * 双层防线中的 guard 层:token 级静态分析,fail-closed——解析不了就拒绝。
 * 编译器层(口径 SQL 由 MetricSqlCompiler 生成)不在此文件。
 */

export interface GuardPolicy {
  /** 物理表白名单(全限定名 catalog.schema.table);空表 = 默认全拒 */
  allowedTables: string[];
  /** 行数上限:无 LIMIT 追加、超出收紧 */
  maxRow: number;
  /** 敏感列黑名单(裸列名,大小写不敏感) */
  sensitiveColumns?: string[];
}

export type GuardResult =
  | { ok: true; sql: string; appliedLimit: boolean }
  | { ok: false; rule: string; reason: string };

type TokKind = "word" | "num" | "punct";
interface Tok {
  kind: TokKind;
  v: string;
  start: number;
  end: number;
}

const LEAD_WORDS = new Set(["SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"]);
const FORBIDDEN = new Set([
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT",
  "REVOKE", "SET", "KILL", "LOAD", "EXPORT", "CALL", "EXECUTE", "MERGE",
  "RENAME", "ANALYZE", "OPTIMIZE", "LOCK", "UNLOCK", "USE",
]);

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

/** tokenizer:剥离字符串与注释(它们不参与任何规则),反引号标识符归一为 word */
export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && src[i + 1] === "-") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) {
          if (src[i + 1] === q) { i += 2; continue; } // 双写转义
          i++;
          break;
        }
        i++;
      }
      continue; // 字符串字面量整体丢弃
    }
    if (c === "`") {
      const start = i;
      i++;
      let v = "";
      while (i < n) {
        if (src[i] === "`") {
          if (src[i + 1] === "`") { v += "`"; i += 2; continue; }
          i++;
          break;
        }
        v += src[i]!;
        i++;
      }
      toks.push({ kind: "word", v, start, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[0-9.]/.test(src[i]!)) i++;
      toks.push({ kind: "num", v: src.slice(start, i), start, end: i });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentChar(src[i]!)) i++;
      toks.push({ kind: "word", v: src.slice(start, i), start, end: i });
      continue;
    }
    toks.push({ kind: "punct", v: c, start: i, end: i + 1 });
    i++;
  }
  return toks;
}

/** 提取 CTE 名:形如 `name AS (` 的定义(WITH 子句内) */
function collectCteNames(toks: Tok[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i + 2 < toks.length; i++) {
    const a = toks[i]!;
    const b = toks[i + 1]!;
    const c = toks[i + 2]!;
    if (a.kind === "word" && b.kind === "word" && b.v.toUpperCase() === "AS" &&
        c.kind === "punct" && c.v === "(") {
      names.add(a.v);
    }
  }
  return names;
}

/** 从 FROM/JOIN 后提取全限定表名(含逗号多表;子查询括号自然跳过;CTE 名由调用方豁免) */
function collectTables(toks: Tok[]): string[] {
  const out: string[] = [];
  const chainAt = (j: number): { name: string; next: number } | null => {
    if (!toks[j] || toks[j]!.kind !== "word") return null;
    let name = toks[j]!.v;
    let k = j + 1;
    while (toks[k] && toks[k]!.kind === "punct" && toks[k]!.v === "." && toks[k + 1]?.kind === "word") {
      name += "." + toks[k + 1]!.v;
      k += 2;
    }
    return { name, next: k };
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "word" && (t.v.toUpperCase() === "FROM" || t.v.toUpperCase() === "JOIN")) {
      let j = i + 1;
      for (;;) {
        const chain = chainAt(j);
        if (!chain) break;
        out.push(chain.name);
        j = chain.next;
        // 跳过别名(单标识符)后继续检查逗号(P0-1 修复:FROM a, secret b)
        if (toks[j]?.kind === "word" && !["ORDER", "LIMIT", "WHERE", "GROUP", "HAVING", "UNION", "ON", "AS", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "JOIN"].includes(toks[j]!.v.toUpperCase())) {
          j++; // skip alias
        }
        if (toks[j]?.kind === "punct" && toks[j]!.v === ",") { j++; continue; }
        break;
      }
    }
  }
  return out;
}

export function guard(rawSql: string, policy: GuardPolicy): GuardResult {
  const src = rawSql ?? "";
  const toks = tokenize(src);
  const meaningful = toks.filter((t) => t.kind !== "punct");
  if (meaningful.length === 0) {
    return { ok: false, rule: "R2_lead_word", reason: "空语句或仅含注释/字符串" };
  }

  // R1 单语句:分号只允许出现在最后一个 token
  const semis = toks.filter((t) => t.kind === "punct" && t.v === ";");
  const last = toks[toks.length - 1];
  const trailingOnly = semis.length === 0 || (semis.length === 1 && last?.v === ";");
  if (!trailingOnly) {
    return { ok: false, rule: "R1_multi_statement", reason: "检测到多条语句(裸分号)" };
  }

  // R2 首词白名单
  const first = meaningful[0]!;
  const lead = first.kind === "word" ? first.v.toUpperCase() : "";
  if (!LEAD_WORDS.has(lead)) {
    return { ok: false, rule: "R2_lead_word", reason: `首词 ${lead || "(非标识符)"} 不在只读白名单` };
  }

  // R3 关键词黑名单(token 级,字符串/注释已被剥离)
  for (const t of toks) {
    if (t.kind === "word" && FORBIDDEN.has(t.v.toUpperCase())) {
      return { ok: false, rule: "R3_forbidden_keyword", reason: `禁用关键词 ${t.v}` };
    }
  }

  // SHOW/DESC 允许跳过 LIMIT;但 EXPLAIN 和 DESC 的表仍须过白名单(P0-1 修复)
  const skipLimit = lead === "SHOW";
  const checkTable = true; // 所有语句的表引用都检查白名单

  if (checkTable) {
    // R4 表白名单(CTE 别名豁免;所有语句含 EXPLAIN/DESC 都检查)
    const cteNames = collectCteNames(toks);
    const tables = collectTables(toks).filter((t) => !cteNames.has(t));
    const allowed = new Set(policy.allowedTables.map((t) => t.trim()));
    for (const tb of tables) {
      if (!allowed.has(tb)) {
        return { ok: false, rule: "R4_table_whitelist", reason: `表 ${tb} 不在白名单` };
      }
    }

    // R6 敏感列(裸列名精确匹配;SELECT * 也须拦截)
    const sensitive = new Set((policy.sensitiveColumns ?? []).map((c) => c.toLowerCase()));
    if (sensitive.size > 0) {
      // SELECT * + 敏感列配置 → 拒绝(无法验证 * 不含敏感列)
      const hasStar = toks.some((t, idx) => t.kind === "punct" && t.v === "*" && idx > 0 && toks[idx - 1]?.v.toUpperCase() === "SELECT");
      if (hasStar) {
        return { ok: false, rule: "R6_sensitive_column", reason: "SELECT * 与敏感列配置冲突(无法验证不含敏感列)" };
      }
      for (const t of toks) {
        if (t.kind === "word" && sensitive.has(t.v.toLowerCase())) {
          return { ok: false, rule: "R6_sensitive_column", reason: `敏感列 ${t.v}` };
        }
      }
    }
  }

  // R5 LIMIT:仅对查询语句强制;SHOW 天然受限
  let sql = src;
  let appliedLimit = false;
  if (!skipLimit) {
    let limitTok: Tok | null = null;
    for (const t of toks) {
      if (t.kind === "word" && t.v.toUpperCase() === "LIMIT") limitTok = t;
    }
    if (limitTok) {
      const idx = toks.indexOf(limitTok);
      const numTok = toks[idx + 1];
      if (!numTok || numTok.kind !== "num" || !/^\d+$/.test(numTok.v)) {
        return { ok: false, rule: "R5_limit", reason: "LIMIT 后必须是数字字面量(无法验证上限)" };
      }
      const clamped = Math.min(parseInt(numTok.v, 10), policy.maxRow);
      if (clamped !== parseInt(numTok.v, 10)) {
        sql = sql.slice(0, numTok.start) + String(clamped) + sql.slice(numTok.end);
        appliedLimit = true;
      }
    } else {
      sql = sql.replace(/[\s;]+$/, "") + ` LIMIT ${policy.maxRow}`;
      appliedLimit = true;
    }
  }

  return { ok: true, sql, appliedLimit };
}
